import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { normaliseLocations, prioritiseLocations } from './normalise.js';
import type { LocationType } from '../domain/models.js';

// Feature: tfnsw-route-planner, Property 1: Location results are capped at 10
//
// Validates: Requirements 1.1
//
// For any upstream stop-finder response containing N valid location entries,
// the prioritised location list returned by
// `prioritiseLocations(normaliseLocations(efa))` has length equal to
// `min(N, 10)`, and never exceeds 10.
//
// NOTE: `normaliseLocations` no longer caps its output — it returns ALL valid
// normalised locations. The cap-at-10 now lives in the pure `prioritiseLocations`
// function (which also orders results by priority tier + match quality). This
// property therefore exercises the cap through that function.
//
// `normaliseLocations(efa)` accepts the raw (untrusted) EFA stop-finder payload
// and returns the normalised `Location[]`. The modern EFA shape is
// `{ locations: [...] }`, which is what this property generates. To isolate the
// cap behaviour from the validity/coercion behaviour, the generator only emits
// VALID entries (each with a non-empty `id` and `name`) so that every generated
// entry survives normalisation and the resulting count is purely a function of
// N and the cap.

/** Raw EFA `type` tokens the normaliser recognises (drawn from EFA_TYPE_MAP). */
const EFA_TYPE_TOKEN_ARB: fc.Arbitrary<string> = fc.constantFrom(
  'stop',
  'stoppoint',
  'station',
  'platform',
  'poi',
  'suburb',
  'locality',
  'address',
  'street',
);

/** The set of valid normalised LocationType values (mirrors the union). */
const VALID_LOCATION_TYPES: ReadonlySet<LocationType> = new Set<LocationType>([
  'stop',
  'station',
  'platform',
  'poi',
  'address',
  'suburb',
]);

/** A finite latitude/longitude coordinate, used as an EFA `[lat, lng]` pair. */
const COORD_ARB: fc.Arbitrary<[number, number]> = fc.tuple(
  fc.double({ min: -90, max: 90, noNaN: true }),
  fc.double({ min: -180, max: 180, noNaN: true }),
);

/**
 * A single VALID EFA-shaped stop-finder entry: always carries a non-empty `id`
 * and a non-empty `name` (so it survives normalisation), a recognised `type`
 * token, plus an optional `coord` array and optional `parent` locality.
 */
const EFA_ENTRY_ARB: fc.Arbitrary<Record<string, unknown>> = fc
  .record(
    {
      id: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
      name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
      type: EFA_TYPE_TOKEN_ARB,
      coord: fc.option(COORD_ARB, { nil: undefined }),
      parent: fc.option(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          type: fc.constantFrom('locality', 'suburb'),
        }),
        { nil: undefined },
      ),
    },
    { requiredKeys: ['id', 'name', 'type'] },
  );

/** An EFA stop-finder payload `{ locations: [...] }` with 0..~30 valid entries. */
const EFA_PAYLOAD_ARB = fc
  .array(EFA_ENTRY_ARB, { minLength: 0, maxLength: 30 })
  .map((locations) => ({ payload: { locations }, n: locations.length }));

describe('prioritiseLocations location cap (Property 1)', () => {
  it('returns exactly min(N, 10) locations and never exceeds 10', () => {
    fc.assert(
      fc.property(EFA_PAYLOAD_ARB, ({ payload, n }) => {
        // The cap now lives in prioritiseLocations; normaliseLocations returns
        // all N valid locations, which we then prioritise + cap.
        const normalised = normaliseLocations(payload);
        expect(normalised.length).toBe(n);

        const result = prioritiseLocations(normalised);

        // Core property: count equals min(N, 10).
        expect(result.length).toBe(Math.min(n, 10));

        // Explicit upper-bound assertion: never exceeds the cap.
        expect(result.length).toBeLessThanOrEqual(10);

        // Sanity: every returned entry is a well-formed Location, confirming the
        // generated entries were genuinely valid (so the count reflects the cap,
        // not silent dropping).
        for (const loc of result) {
          expect(typeof loc.name).toBe('string');
          expect(loc.name.length).toBeGreaterThan(0);
          expect(VALID_LOCATION_TYPES.has(loc.type)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('caps a payload of 30 entries at 10', () => {
    const locations = Array.from({ length: 30 }, (_, i) => ({
      id: `stop-${i}`,
      name: `Stop ${i}`,
      type: 'stop',
    }));
    expect(prioritiseLocations(normaliseLocations({ locations })).length).toBe(10);
  });

  it('returns all entries when N is below the cap', () => {
    const locations = Array.from({ length: 4 }, (_, i) => ({
      id: `stop-${i}`,
      name: `Stop ${i}`,
      type: 'stop',
    }));
    expect(prioritiseLocations(normaliseLocations({ locations })).length).toBe(4);
  });

  it('returns an empty list for zero entries', () => {
    expect(prioritiseLocations(normaliseLocations({ locations: [] }))).toEqual([]);
  });
});
