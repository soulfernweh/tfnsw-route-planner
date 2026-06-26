// Location autocomplete service (Requirement 1).
//
// Implements the `LocationService` contract from the domain models: a single
// `searchLocations(query)` method that returns up to 10 normalised
// `Location`s for a free-text query.
//
// Responsibilities (design: "Request Flows" → Location search, "Caching
// Strategy", "Error Handling"):
//
//   1. SHORT-QUERY GUARD (Req 1.6) — if the trimmed query has fewer than 3
//      characters, return an empty list IMMEDIATELY without invoking the
//      TfNSW client. This clears any previously shown results and avoids
//      pointless upstream calls / quota usage.
//   2. CACHING (design "Caching Strategy") — stop-finder results are cached in
//      an in-memory TTL+LRU cache, keyed by the normalised (lowercased,
//      trimmed) query via `stopFinderCacheKey`, with the ~24h
//      `STOP_FINDER_TTL_MS` TTL. A cache hit avoids the upstream call.
//   3. UPSTREAM CALL + CAP (Req 1.1) — on a miss, call the injected client's
//      `stopFinder`, store the result in the cache, and return at most 10
//      locations. An empty list is a valid result (drives "no locations
//      found", Req 1.4).
//   4. ERROR PROPAGATION (Req 1.5) — upstream failures surface as
//      `ServiceUnavailableError` from the client; this service does NOT
//      swallow them. They propagate to the caller unchanged.
//
// DEPENDENCY INJECTION / TESTABILITY: the constructor takes the TfNSW client
// (narrowed to the minimal `StopFinderClient` interface — just `stopFinder`)
// and an optional pre-built cache. Tests can inject a fake client and a fresh
// cache to exercise the guard, cache, and error behaviours without real I/O.
//
// Design reference: .kiro/specs/tfnsw-route-planner/design.md
// Requirements: 1.1, 1.4, 1.6.

import type { Location, LocationService } from '../domain/models.js';
import {
  STOP_FINDER_TTL_MS,
  TtlLruCache,
  stopFinderCacheKey,
} from '../infra/cache.js';

/**
 * The minimal client surface this service depends on: just the stop-finder
 * autocomplete call. `TfnswClient` satisfies this structurally, but narrowing
 * the dependency keeps the service trivially unit-testable with a fake.
 */
export interface StopFinderClient {
  stopFinder(query: string): Promise<Location[]>;
}

/** Minimum trimmed query length before the upstream API is queried (Req 1.6). */
export const MIN_QUERY_LENGTH = 3;

/**
 * Default capacity for the service-owned stop-finder cache. Location queries
 * are diverse but repeat (popular stops, partial typing), so a few hundred
 * entries gives a good hit rate without unbounded growth.
 */
const DEFAULT_CACHE_MAX_SIZE = 500;

/** Maximum number of locations returned to clients (Req 1.1). */
const MAX_RESULTS = 10;

/**
 * Location autocomplete service backed by the TfNSW stop finder and an
 * in-memory TTL+LRU cache.
 */
export class DefaultLocationService implements LocationService {
  private readonly client: StopFinderClient;
  private readonly cache: TtlLruCache<Location[]>;

  /**
   * @param client - the TfNSW client (or any object exposing `stopFinder`).
   * @param cache - optional pre-built cache for stop-finder results. Defaults
   *   to a fresh `TtlLruCache` with a sensible capacity. Inject in tests to
   *   observe/seed cache behaviour.
   */
  public constructor(
    client: StopFinderClient,
    cache: TtlLruCache<Location[]> = new TtlLruCache<Location[]>({
      maxSize: DEFAULT_CACHE_MAX_SIZE,
    }),
  ) {
    this.client = client;
    this.cache = cache;
  }

  /**
   * Search for up to 10 locations matching `query`.
   *
   * Returns an empty list immediately (no upstream call) when the trimmed query
   * is shorter than {@link MIN_QUERY_LENGTH}. Otherwise returns cached results
   * when present, else fetches from the client, caches, and returns them.
   * Upstream failures propagate as `ServiceUnavailableError` (not swallowed).
   */
  public async searchLocations(query: string): Promise<Location[]> {
    // (1) Short-query guard (Req 1.6): never reaches the API.
    if (query.trim().length < MIN_QUERY_LENGTH) {
      return [];
    }

    // (2) Cache lookup, keyed by the normalised query.
    const key = stopFinderCacheKey(query);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // (3) Miss: fetch from upstream. A thrown ServiceUnavailableError
    // propagates to the caller (Req 1.5) — deliberately not caught here.
    const locations = await this.client.stopFinder(query);

    // Cap defensively at 10 (Req 1.1); cache the capped result so subsequent
    // hits are consistent with what callers receive.
    const capped = locations.slice(0, MAX_RESULTS);
    this.cache.set(key, capped, STOP_FINDER_TTL_MS);
    return capped;
  }
}
