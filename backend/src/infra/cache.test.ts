import { describe, it, expect } from 'vitest';

import {
  TtlLruCache,
  normaliseQuery,
  stopFinderCacheKey,
  tripTimeBucket,
  tripCacheKey,
  buildCacheKey,
  STOP_FINDER_TTL_MS,
  TRIP_TTL_MS,
  TRIP_TIME_BUCKET_MS,
} from './cache.js';

// Feature: tfnsw-route-planner, Task 7.2: Unit tests for cache hit/miss, TTL
// expiry, LRU eviction, and the key-building helpers.
//
// Validates: Design "Caching Strategy".
//
// All time-dependent tests use a mutable `now` closure so expiry is exercised
// deterministically without real delays.

/** Create a cache plus a setter that advances/controls the injected clock. */
function makeCache<V>(maxSize: number, startNow = 1_000) {
  let current = startNow;
  const cache = new TtlLruCache<V>({ maxSize, now: () => current });
  return {
    cache,
    setNow: (value: number) => {
      current = value;
    },
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

describe('TtlLruCache hit/miss', () => {
  it('returns the value after set (hit)', () => {
    const { cache } = makeCache<string>(10);
    cache.set('k', 'v', 1000);
    expect(cache.get('k')).toBe('v');
  });

  it('returns undefined for a missing key (miss)', () => {
    const { cache } = makeCache<string>(10);
    expect(cache.get('absent')).toBeUndefined();
  });

  it('overwrites an existing key with set', () => {
    const { cache } = makeCache<string>(10);
    cache.set('k', 'first', 1000);
    cache.set('k', 'second', 1000);
    expect(cache.get('k')).toBe('second');
  });
});

describe('TtlLruCache TTL expiry', () => {
  it('returns the value before the ttl elapses', () => {
    const { cache, setNow } = makeCache<string>(10, 0);
    cache.set('k', 'v', 100);
    setNow(99); // strictly before expiry (expiresAt === 100)
    expect(cache.get('k')).toBe('v');
  });

  it('returns undefined once now reaches/passes the ttl and evicts the entry', () => {
    const { cache, setNow } = makeCache<string>(10, 0);
    cache.set('k', 'v', 100);

    // At exactly expiresAt the entry is dead (now >= expiresAt).
    setNow(100);
    expect(cache.get('k')).toBeUndefined();
    // The expired entry was evicted as a side effect of the read.
    expect(cache.size).toBe(0);
  });

  it('evicts a long-expired entry on access', () => {
    const { cache, advance } = makeCache<string>(10, 1_000);
    cache.set('k', 'v', 50);
    advance(10_000);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('TtlLruCache LRU eviction', () => {
  it('evicts the least-recently-used entry when exceeding maxSize', () => {
    const { cache } = makeCache<number>(3);
    cache.set('a', 1, 10_000);
    cache.set('b', 2, 10_000);
    cache.set('c', 3, 10_000);
    // Inserting a 4th entry (N+1) evicts the LRU, which is 'a'.
    cache.set('d', 4, 10_000);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('get() refreshes recency so the refreshed key survives later eviction', () => {
    const { cache } = makeCache<number>(3);
    cache.set('a', 1, 10_000);
    cache.set('b', 2, 10_000);
    cache.set('c', 3, 10_000);

    // Touch 'a' so it becomes most-recently-used; 'b' is now the LRU.
    expect(cache.get('a')).toBe(1);

    // Inserting 'd' should evict 'b' (the LRU), not the refreshed 'a'.
    cache.set('d', 4, 10_000);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });
});

describe('normaliseQuery', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normaliseQuery('  Town Hall ')).toBe('town hall');
  });

  it('treats equivalent queries as equal after normalisation', () => {
    expect(normaliseQuery('  TOWN hall')).toBe(normaliseQuery('town hall  '));
  });
});

describe('stopFinderCacheKey', () => {
  it('is stable for queries that are equivalent after normalisation', () => {
    expect(stopFinderCacheKey('  Central ')).toBe(stopFinderCacheKey('central'));
  });

  it('differs for genuinely different queries', () => {
    expect(stopFinderCacheKey('central')).not.toBe(stopFinderCacheKey('town hall'));
  });
});

describe('tripTimeBucket', () => {
  it('rounds a time down to the start of its bucket', () => {
    // 90_000 ms with a 60_000 ms bucket -> floor to 60_000.
    const date = new Date(90_000);
    expect(tripTimeBucket(date, TRIP_TIME_BUCKET_MS)).toBe(60_000);
  });

  it('returns the exact bucket start unchanged when already aligned', () => {
    const date = new Date(120_000);
    expect(tripTimeBucket(date, TRIP_TIME_BUCKET_MS)).toBe(120_000);
  });

  it('places times within the same bucket on the same boundary', () => {
    const a = tripTimeBucket(new Date(60_001), TRIP_TIME_BUCKET_MS);
    const b = tripTimeBucket(new Date(119_999), TRIP_TIME_BUCKET_MS);
    expect(a).toBe(b);
    expect(a).toBe(60_000);
  });

  it('throws on a non-positive bucket width', () => {
    expect(() => tripTimeBucket(new Date(0), 0)).toThrow();
  });
});

describe('buildCacheKey / tripCacheKey collisions', () => {
  it('does not collide between ["a","bc"] and ["ab","c"]', () => {
    expect(buildCacheKey('ns', 'a', 'bc')).not.toBe(buildCacheKey('ns', 'ab', 'c'));
  });

  it('produces distinct trip keys for distinct origin/destination splits', () => {
    expect(tripCacheKey('a', 'bc', 60_000)).not.toBe(tripCacheKey('ab', 'c', 60_000));
  });

  it('produces distinct trip keys for distinct time buckets', () => {
    expect(tripCacheKey('a', 'b', 60_000)).not.toBe(tripCacheKey('a', 'b', 120_000));
  });

  it('is deterministic for identical parts', () => {
    expect(tripCacheKey('a', 'b', 60_000)).toBe(tripCacheKey('a', 'b', 60_000));
  });
});

describe('TTL constants', () => {
  it('exposes the design Caching Strategy TTLs', () => {
    expect(STOP_FINDER_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(TRIP_TTL_MS).toBe(60 * 1000);
    expect(TRIP_TIME_BUCKET_MS).toBe(60 * 1000);
  });
});
