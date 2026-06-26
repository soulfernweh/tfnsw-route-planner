// In-memory LRU cache with per-entry TTL (time-to-live).
//
// This is a standalone, deterministic infrastructure primitive used by the
// backend service layer to cache TfNSW responses, per the design's "Caching
// Strategy":
//   .kiro/specs/tfnsw-route-planner/design.md ("Caching Strategy")
//
//   - Stop Finder responses are cached keyed by the normalised (lowercased,
//     trimmed) query string, with a long (~24h) TTL because location data
//     changes infrequently.
//   - Trip responses are cached keyed by (originId, destinationId, time-bucket)
//     with a short (~60s) TTL because schedules and the implicit "now" change
//     quickly; the request time is rounded to a small bucket to improve hit
//     rate while staying current.
//
// SCOPE (task 7.1): this module provides ONLY the cache primitive plus the
// key-building / time-bucketing helpers and the TTL constants. It deliberately
// does NOT wire itself into `TfnswClient`; that integration happens when the
// services are built (tasks 7.x / 8.x). Accordingly, no global mutable cache
// singleton is exported — callers construct their own `TtlLruCache` instance.
//
// DETERMINISM / TESTABILITY: the time source is injectable via the `now`
// option (defaulting to `Date.now`) so tests can advance time and exercise
// expiry without real delays. The cache performs no I/O.

/** Options for constructing a {@link TtlLruCache}. */
export interface TtlLruCacheOptions {
  /**
   * Maximum number of live entries. When inserting beyond this capacity, the
   * least-recently-used entry is evicted. Must be a positive integer.
   */
  maxSize: number;
  /**
   * Monotonic-ish time source returning epoch milliseconds, used for TTL
   * expiry. Defaults to {@link Date.now}. Injected so tests can control time.
   */
  now?: () => number;
}

/** Internal stored entry: the value plus its absolute expiry timestamp. */
interface CacheEntry<V> {
  value: V;
  /** Epoch ms at which this entry expires (entry is dead when now >= this). */
  expiresAt: number;
}

/**
 * A generic, in-memory cache combining:
 *  - per-entry TTL expiry (lazy: expired entries are treated as absent and are
 *    evicted on access), and
 *  - a least-recently-used (LRU) eviction policy bounded by `maxSize`.
 *
 * Keys are strings (build them with {@link buildCacheKey} and friends). The
 * cache is intentionally not thread-shared state — construct one per consumer.
 *
 * Recency: both {@link TtlLruCache.get} (on a live hit) and
 * {@link TtlLruCache.set} mark a key as most-recently-used. Insertion order of
 * the backing `Map` is used as the recency order, with the oldest key evicted
 * first when capacity is exceeded.
 *
 * @typeParam V - the type of cached values
 */
export class TtlLruCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new Error('TtlLruCache: maxSize must be a positive integer');
    }
    this.maxSize = options.maxSize;
    this.now = options.now ?? Date.now;
  }

  /**
   * Retrieve a live value for `key`.
   *
   * Returns `undefined` when the key is missing OR its entry has expired. An
   * expired entry encountered here is evicted as a side effect. A live hit
   * refreshes the key's recency (marking it most-recently-used).
   *
   * @param key - the cache key
   * @returns the cached value, or `undefined` if missing/expired
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (this.now() >= entry.expiresAt) {
      // Lazily evict the expired entry.
      this.store.delete(key);
      return undefined;
    }

    // Refresh recency: re-insert so this key becomes most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * Insert or replace the value for `key`, expiring `ttlMs` from now.
   *
   * Setting a key marks it most-recently-used. If the insertion pushes the
   * cache beyond `maxSize`, the least-recently-used entries are evicted until
   * the cache is back within capacity.
   *
   * @param key - the cache key
   * @param value - the value to cache
   * @param ttlMs - time-to-live in milliseconds; must be a positive, finite number
   */
  set(key: string, value: V, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('TtlLruCache: ttlMs must be a positive, finite number');
    }

    // Delete first so the re-insert places the key at the most-recent end.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });

    // Evict least-recently-used entries while over capacity.
    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }

  /**
   * Whether a LIVE entry exists for `key`. Expired entries are evicted and
   * reported as absent. Does not affect recency.
   *
   * @param key - the cache key
   * @returns true when a non-expired entry exists
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return false;
    }
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /** Remove a single entry. Returns true if an entry was present. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /**
   * Number of entries currently held, INCLUDING any that have expired but not
   * yet been accessed/evicted. Primarily useful for tests and diagnostics.
   */
  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// TTL constants (from the design's Caching Strategy)
// ---------------------------------------------------------------------------

/** Stop Finder cache TTL: ~24 hours (location data changes infrequently). */
export const STOP_FINDER_TTL_MS = 24 * 60 * 60 * 1000;

/** Trip cache TTL: ~60 seconds (schedules and the implicit "now" change fast). */
export const TRIP_TTL_MS = 60 * 1000;

/**
 * Default trip time-bucket width (60s), matching {@link TRIP_TTL_MS}. Requests
 * are rounded to this bucket so near-simultaneous requests share a cache entry
 * while staying current.
 */
export const TRIP_TIME_BUCKET_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Key-building helpers
// ---------------------------------------------------------------------------

/** Separator between key parts; chosen to avoid collision with normal text. */
const KEY_SEPARATOR = '\u241F'; // SYMBOL FOR UNIT SEPARATOR

/**
 * Build a stable cache key from a namespace and ordered parts.
 *
 * Parts are joined with a control-character separator that is extremely
 * unlikely to appear in inputs, so distinct part tuples cannot collide (e.g.
 * `['a', 'bc']` and `['ab', 'c']` produce different keys).
 *
 * @param namespace - logical key namespace (e.g. `'stopFinder'`, `'trip'`)
 * @param parts - ordered key components
 * @returns a deterministic cache key string
 */
export function buildCacheKey(
  namespace: string,
  ...parts: ReadonlyArray<string | number>
): string {
  return [namespace, ...parts.map((p) => String(p))].join(KEY_SEPARATOR);
}

/**
 * Normalise a stop-finder query for caching: trim surrounding whitespace and
 * lowercase, so `"  Town Hall "` and `"town hall"` share a cache entry. This
 * matches the design's "normalised (lowercased, trimmed) query" key.
 *
 * @param query - the raw user query
 * @returns the normalised query string
 */
export function normaliseQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Cache key for a Stop Finder response, keyed by the normalised query.
 *
 * @param query - the raw user query (normalised internally)
 * @returns the cache key
 */
export function stopFinderCacheKey(query: string): string {
  return buildCacheKey('stopFinder', normaliseQuery(query));
}

/**
 * Round a request time down to the start of its time bucket, returning the
 * bucket's epoch-millisecond start. Trip requests sharing a bucket share a
 * cache entry.
 *
 * @param date - the request time
 * @param bucketMs - bucket width in ms (defaults to {@link TRIP_TIME_BUCKET_MS})
 * @returns the bucket start as epoch ms
 */
export function tripTimeBucket(
  date: Date,
  bucketMs: number = TRIP_TIME_BUCKET_MS,
): number {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new Error('tripTimeBucket: bucketMs must be a positive, finite number');
  }
  return Math.floor(date.getTime() / bucketMs) * bucketMs;
}

/**
 * Cache key for a Trip response, keyed by `(originId, destinationId,
 * time-bucket)`. The caller supplies the bucket value (typically from
 * {@link tripTimeBucket}).
 *
 * @param originId - origin location id
 * @param destinationId - destination location id
 * @param timeBucket - bucket start epoch ms (see {@link tripTimeBucket})
 * @returns the cache key
 */
export function tripCacheKey(
  originId: string,
  destinationId: string,
  timeBucket: number,
): string {
  return buildCacheKey('trip', originId, destinationId, timeBucket);
}
