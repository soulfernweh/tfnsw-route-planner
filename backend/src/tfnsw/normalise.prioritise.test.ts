import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { prioritiseLocations } from './normalise.js';
import type { Location, LocationType, TransportMode } from '../domain/models.js';

// Feature: tfnsw-route-planner, Property 15: Location prioritisation orders by
// tier then match quality
//
// Validates: Requirements 1.3, 1.4
//
// `prioritiseLocations(locations)` orders the normalised `Location[]` for
// display per the design's Location Prioritisation Algorithm and caps the
// result at 10. For ANY array of `Location` values, the output must satisfy:
//   (a) length === min(N, 10) — the cap (Req 1.1, exercised here as a structural
//       invariant of the ordering pass);
//   (b) non-decreasing by priority TIER (Req 1.3) — a train/metro station never
//       appears after a ferry wharf, which never appears after a bus stop, etc.;
//   (c) within the SAME tier, non-increasing by `matchQuality` (Req 1.4) — the
//       better-matching result of two same-tier locations is never ordered last.
//
// The tier is recomputed in the test by an INDEPENDENT reference function
// (`referenceTier`) so the property does not merely re-assert the production
// implementation. The reference encodes the design's tiers directly:
//   Tier 1 — train or metro (best)
//   Tier 2 — ferry
//   Tier 3 — bus
//   Tier 4 — other transit: lightRail / coach / school
//   Tier 5 — non-transit / no transit modes (worst)
// A multi-mode location takes the LOWEST (best) tier among its served modes.

/** The seven user-selectable / served transit modes a stop can carry. */
const SELECTABLE_MODES: readonly TransportMode[] = [
  'train',
  'metro',
  'lightRail',
  'bus',
  'coach',
  'ferry',
  'school',
];

/** All valid normalised location types. */
const LOCATION_TYPES: readonly LocationType[] = [
  'stop',
  'station',
  'platform',
  'poi',
  'address',
  'suburb',
];

/**
 * INDEPENDENT reference implementation of the priority-tier assignment used by
 * the algorithm. Deliberately written separately from the production
 * `priorityTier` so the property cross-checks behaviour rather than mirroring
 * the implementation. A multi-mode location takes the lowest (best) tier.
 */
function referenceTier(location: Location): number {
  const modes = location.modes;
  if (modes.includes('train') || modes.includes('metro')) {
    return 1;
  }
  if (modes.includes('ferry')) {
    return 2;
  }
  if (modes.includes('bus')) {
    return 3;
  }
  if (
    modes.includes('lightRail') ||
    modes.includes('coach') ||
    modes.includes('school')
  ) {
    return 4;
  }
  return 5;
}

/** A finite latitude/longitude coordinate, as `Location.coord`. */
const COORD_ARB: fc.Arbitrary<{ lat: number; lng: number }> = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true }),
  lng: fc.double({ min: -180, max: 180, noNaN: true }),
});

/**
 * A `Location` arbitrary: non-empty id + name, a type from the valid set, a
 * `modes` array that is any subset (possibly empty, possibly multi-mode) of the
 * seven selectable modes, an integer `matchQuality`, and a nullable `coord`.
 *
 * `matchQuality` is intentionally drawn from a SMALL integer range so ties
 * within a tier occur frequently, exercising the same-tier ordering (c) and the
 * stable-sort behaviour.
 */
const LOCATION_ARB: fc.Arbitrary<Location> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
  name: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
  type: fc.constantFrom(...LOCATION_TYPES),
  suburb: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: null }),
  // Any subset of the selectable modes, deduplicated, including the empty set
  // (non-transit) and multi-tier combinations (e.g. train + bus -> tier 1).
  modes: fc
    .subarray([...SELECTABLE_MODES])
    .map((modes) => Array.from(new Set(modes))),
  matchQuality: fc.integer({ min: -5, max: 20 }),
  coord: fc.option(COORD_ARB, { nil: null }),
});

/** An array of 0..30 Locations (spans below and above the cap of 10). */
const LOCATIONS_ARB: fc.Arbitrary<Location[]> = fc.array(LOCATION_ARB, {
  minLength: 0,
  maxLength: 30,
});

describe('prioritiseLocations ordering (Property 15)', () => {
  it('orders by tier ascending then matchQuality descending, capped at 10', () => {
    fc.assert(
      fc.property(LOCATIONS_ARB, (locations) => {
        const result = prioritiseLocations(locations);

        // (a) Length is min(N, 10) and never exceeds the cap.
        expect(result.length).toBe(Math.min(locations.length, 10));
        expect(result.length).toBeLessThanOrEqual(10);

        // (b) + (c): scan adjacent pairs of the output.
        for (let i = 1; i < result.length; i += 1) {
          const prevTier = referenceTier(result[i - 1]!);
          const currTier = referenceTier(result[i]!);

          // (b) Non-decreasing by priority tier.
          expect(prevTier).toBeLessThanOrEqual(currTier);

          // (c) Within the same tier, non-increasing by matchQuality.
          if (prevTier === currTier) {
            expect(result[i - 1]!.matchQuality).toBeGreaterThanOrEqual(
              result[i]!.matchQuality,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keeps the 10 best entries: every dropped location is no better than the worst kept', () => {
    // When N > 10, the cap must drop the LOWEST-priority entries, never a
    // higher-priority one. The last kept entry's (tier, -matchQuality) key must
    // be <= every dropped entry's key.
    fc.assert(
      fc.property(
        fc.array(LOCATION_ARB, { minLength: 11, maxLength: 30 }),
        (locations) => {
          const result = prioritiseLocations(locations);
          expect(result).toHaveLength(10);

          const worstKept = result[result.length - 1]!;
          const worstTier = referenceTier(worstKept);

          // Identify which locations were dropped (by reference identity).
          const keptSet = new Set(result);
          const dropped = locations.filter((loc) => !keptSet.has(loc));

          for (const d of dropped) {
            const dTier = referenceTier(d);
            // A dropped entry is never in a strictly better tier than the worst
            // kept entry...
            expect(dTier).toBeGreaterThanOrEqual(worstTier);
            // ...and if it shares the worst kept tier, its matchQuality is no
            // greater (ties broken by original order are acceptable: <=).
            if (dTier === worstTier) {
              expect(d.matchQuality).toBeLessThanOrEqual(worstKept.matchQuality);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  const loc = (
    id: string,
    modes: TransportMode[],
    matchQuality: number,
    type: LocationType = 'stop',
  ): Location => ({
    id,
    name: `Loc ${id}`,
    type,
    suburb: null,
    modes,
    matchQuality,
    coord: null,
  });

  it('orders a mixed set by tier: train < ferry < bus < lightRail < non-transit', () => {
    const result = prioritiseLocations([
      loc('bus', ['bus'], 50),
      loc('none', [], 99),
      loc('ferry', ['ferry'], 10),
      loc('lr', ['lightRail'], 80),
      loc('train', ['train'], 1),
    ]);
    expect(result.map((l) => l.id)).toEqual(['train', 'ferry', 'bus', 'lr', 'none']);
  });

  it('multi-mode locations take the best (lowest) tier', () => {
    const result = prioritiseLocations([
      loc('busOnly', ['bus'], 90),
      loc('trainAndBus', ['bus', 'train'], 5), // train -> tier 1, beats busOnly
    ]);
    expect(result.map((l) => l.id)).toEqual(['trainAndBus', 'busOnly']);
  });

  it('orders within a tier by matchQuality descending', () => {
    const result = prioritiseLocations([
      loc('low', ['train'], 3),
      loc('high', ['metro'], 30),
      loc('mid', ['train'], 15),
    ]);
    expect(result.map((l) => l.id)).toEqual(['high', 'mid', 'low']);
  });
});
