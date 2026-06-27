import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { DefaultLocationService, MIN_QUERY_LENGTH } from './locationService.js';
import type { StopFinderClient } from './locationService.js';
import type { Location } from '../domain/models.js';
import { TtlLruCache } from '../infra/cache.js';

// Feature: tfnsw-route-planner, Property 3: Short queries never reach the API
//
// Validates: Requirements 1.6
//
// For any query string whose TRIMMED length is less than MIN_QUERY_LENGTH (3),
// `DefaultLocationService.searchLocations` must:
//   1. return an empty list (clearing any previously shown results), AND
//   2. NOT invoke the injected client's `stopFinder` (call count stays 0).
//
// A spy/fake StopFinderClient records how many times `stopFinder` is called so
// the test can assert the upstream API is never touched for short queries. A
// positive contrast confirms the guard is not vacuously true: a query whose
// trimmed length is >= 3 DOES reach the client exactly once (on a cache miss).

/**
 * A fake `StopFinderClient` that records its invocation count and the queries
 * it received. It returns a fixed, non-empty result so a contrast call can be
 * distinguished from the short-query empty result.
 */
function makeSpyClient(result: Location[] = []): StopFinderClient & {
  callCount: number;
  calls: string[];
} {
  const spy = {
    callCount: 0,
    calls: [] as string[],
    async stopFinder(query: string): Promise<Location[]> {
      spy.callCount += 1;
      spy.calls.push(query);
      return result;
    },
  };
  return spy;
}

/** A single sample location used as a non-empty upstream result. */
const SAMPLE_LOCATION: Location = {
  id: 'stop-1',
  name: 'Central Station',
  type: 'station',
  suburb: 'Sydney',
  modes: ['train'],
  matchQuality: 100,
  coord: { lat: -33.883, lng: 151.206 },
};

/** Whitespace characters that `String.prototype.trim` removes. */
const WHITESPACE_ARB: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'),
  { minLength: 0, maxLength: 6 },
);

/**
 * A short query: trimmed length is strictly less than MIN_QUERY_LENGTH.
 *
 * Built as `padding + core + padding`, where `core` holds 0..2 NON-whitespace
 * characters (so the trimmed length equals the core length, which is < 3) and
 * the padding is arbitrary whitespace. This deliberately covers '', '  ', 'a',
 * '  a ', 'ab', and similar whitespace-padded short inputs.
 */
const SHORT_QUERY_ARB: fc.Arbitrary<string> = fc
  .tuple(
    WHITESPACE_ARB,
    fc.stringOf(
      fc.char().filter((c) => c.trim().length > 0),
      { minLength: 0, maxLength: MIN_QUERY_LENGTH - 1 },
    ),
    WHITESPACE_ARB,
  )
  .map(([before, core, after]) => before + core + after)
  // Guard against any surprise where padding chars are not trimmable: enforce
  // the defining invariant of a "short" query.
  .filter((s) => s.trim().length < MIN_QUERY_LENGTH);

/**
 * A non-short query: trimmed length is >= MIN_QUERY_LENGTH. Built as
 * `padding + core + padding` where `core` has 3..12 non-whitespace characters.
 */
const LONG_QUERY_ARB: fc.Arbitrary<string> = fc
  .tuple(
    WHITESPACE_ARB,
    fc.stringOf(
      fc.char().filter((c) => c.trim().length > 0),
      { minLength: MIN_QUERY_LENGTH, maxLength: 12 },
    ),
    WHITESPACE_ARB,
  )
  .map(([before, core, after]) => before + core + after)
  .filter((s) => s.trim().length >= MIN_QUERY_LENGTH);

describe('DefaultLocationService short-query guard (Property 3)', () => {
  it('returns [] and never calls the client for queries with trimmed length < 3', async () => {
    await fc.assert(
      fc.asyncProperty(SHORT_QUERY_ARB, async (query) => {
        const client = makeSpyClient([SAMPLE_LOCATION]);
        const service = new DefaultLocationService(
          client,
          new TtlLruCache<Location[]>({ maxSize: 50 }),
        );

        const result = await service.searchLocations(query);

        // (1) Yields an empty result set (clears any previous results).
        expect(result).toEqual([]);
        // (2) The upstream API is never reached.
        expect(client.callCount).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it('positive contrast: a query with trimmed length >= 3 calls the client exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(LONG_QUERY_ARB, async (query) => {
        const client = makeSpyClient([SAMPLE_LOCATION]);
        const service = new DefaultLocationService(
          client,
          // Fresh cache per run guarantees a cache miss, so the client is hit.
          new TtlLruCache<Location[]>({ maxSize: 50 }),
        );

        const result = await service.searchLocations(query);

        // The guard does NOT short-circuit: the client is invoked once.
        expect(client.callCount).toBe(1);
        // And the (non-empty) upstream result flows back to the caller.
        expect(result).toEqual([SAMPLE_LOCATION]);
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('returns [] without calling the client for the explicit short inputs', async () => {
    for (const query of ['', '  ', 'a', '  a ', 'ab', ' ab ']) {
      const client = makeSpyClient([SAMPLE_LOCATION]);
      const service = new DefaultLocationService(
        client,
        new TtlLruCache<Location[]>({ maxSize: 50 }),
      );

      const result = await service.searchLocations(query);

      expect(result).toEqual([]);
      expect(client.callCount).toBe(0);
    }
  });

  it('calls the client once for a clearly long query', async () => {
    const client = makeSpyClient([SAMPLE_LOCATION]);
    const service = new DefaultLocationService(
      client,
      new TtlLruCache<Location[]>({ maxSize: 50 }),
    );

    const result = await service.searchLocations('central');

    expect(client.callCount).toBe(1);
    expect(result).toEqual([SAMPLE_LOCATION]);
  });
});
