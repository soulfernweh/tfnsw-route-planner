import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildComparison } from './rankingEngine.js';
import type { Fare, Journey, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 13: Missing fare on the fastest route
// is handled in comparison
//
// Validates: Requirements 5.6
//
// `buildComparison(fastest, economical)` must gracefully handle the case where
// the fastest journey has no fare estimate. Specifically, for any journey whose
// fastest journey has a null `totalFare`:
//   - `fareUnavailableForFastest` is true,
//   - `fareDifferenceCents` is null (no fare comparison is possible),
//   - travel-time reporting is preserved: `travelTimeDifferenceMinutes` is
//     non-null whenever an economical journey is present, and equals the
//     absolute difference of the two travel times,
//   - the transfer/travel info on each side is carried through unchanged from
//     the source journeys.
//
// The scenario is constructed by passing a fastest journey with
// `totalFare = null` and an economical journey (priced or null) to
// `buildComparison`.

// --- Helpers ---------------------------------------------------------------

const MODE_ARB: fc.Arbitrary<TransportMode> = fc.constantFrom(
  'train',
  'metro',
  'bus',
  'ferry',
  'lightRail',
  'coach',
  'walk',
  'bicycle',
  'school',
  'other',
);

/** An adult Opal fare in integer cents (>= 0). */
const FARE_ARB: fc.Arbitrary<Fare> = fc
  .integer({ min: 0, max: 100_000 })
  .map((amountCents) => ({ amountCents, currency: 'AUD' as const }));

/** Distinct, ordered modes (length >= 1). */
const MODES_ARB: fc.Arbitrary<TransportMode[]> = fc
  .uniqueArray(MODE_ARB, { minLength: 1, maxLength: 4 })
  .map((modes) => [...modes]);

/**
 * Build a minimal, valid `Journey`. The legs array is intentionally empty: the
 * comparison builder only reads id, travelTimeMinutes, totalFare, transferCount
 * and modes, so a richer leg structure adds nothing for this property.
 */
function makeJourney(opts: {
  id: string;
  travelTimeMinutes: number;
  transferCount: number;
  modes: TransportMode[];
  totalFare: Fare | null;
}): Journey {
  const departureTime = '2020-01-01T08:00:00.000Z';
  const arrivalTime = '2020-01-01T09:00:00.000Z';
  return {
    id: opts.id,
    legs: [],
    departureTime,
    arrivalTime,
    travelTimeMinutes: opts.travelTimeMinutes,
    transferCount: opts.transferCount,
    modes: opts.modes,
    totalFare: opts.totalFare,
  };
}

/** A fastest journey that always has a null totalFare. */
const fastestWithoutFareArb: fc.Arbitrary<Journey> = fc
  .record({
    travelTimeMinutes: fc.integer({ min: 1, max: 600 }),
    transferCount: fc.integer({ min: 0, max: 6 }),
    modes: MODES_ARB,
  })
  .map((j) =>
    makeJourney({
      id: 'fastest',
      travelTimeMinutes: j.travelTimeMinutes,
      transferCount: j.transferCount,
      modes: j.modes,
      totalFare: null,
    }),
  );

/** An economical journey, which may be priced or unpriced (null fare). */
const economicalArb: fc.Arbitrary<Journey> = fc
  .record({
    travelTimeMinutes: fc.integer({ min: 1, max: 600 }),
    transferCount: fc.integer({ min: 0, max: 6 }),
    modes: MODES_ARB,
    totalFare: fc.option(FARE_ARB, { nil: null }),
  })
  .map((j) =>
    makeJourney({
      id: 'economical',
      travelTimeMinutes: j.travelTimeMinutes,
      transferCount: j.transferCount,
      modes: j.modes,
      totalFare: j.totalFare,
    }),
  );

// --- Property 13 -----------------------------------------------------------

describe('buildComparison with missing fare on the fastest route (Property 13)', () => {
  it('flags fareUnavailableForFastest, nulls fareDifferenceCents, and preserves travel/transfer info when an economical journey exists', () => {
    fc.assert(
      fc.property(fastestWithoutFareArb, economicalArb, (fastest, economical) => {
        const result = buildComparison(fastest, economical);

        // Req 5.6: the fastest route's missing fare is signalled, and no fare
        // difference is reported.
        expect(result.fareUnavailableForFastest).toBe(true);
        expect(result.fareDifferenceCents).toBeNull();

        // Travel-time reporting is preserved when both journeys are present.
        expect(result.travelTimeDifferenceMinutes).toBe(
          Math.abs(fastest.travelTimeMinutes - economical.travelTimeMinutes),
        );

        // Transfer/travel info is carried through from the source journeys.
        expect(result.fastest).not.toBeNull();
        expect(result.economical).not.toBeNull();
        expect(result.fastest!.travelTimeMinutes).toBe(fastest.travelTimeMinutes);
        expect(result.fastest!.transferCount).toBe(fastest.transferCount);
        expect(result.fastest!.totalFare).toBeNull();
        expect(result.fastest!.modes).toEqual(fastest.modes);
        expect(result.economical!.travelTimeMinutes).toBe(
          economical.travelTimeMinutes,
        );
        expect(result.economical!.transferCount).toBe(economical.transferCount);

        // With the fastest fare missing there is never a cheaper-route label.
        expect(result.cheaperRouteId).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('still flags fareUnavailableForFastest when there is no economical journey, leaving differences null', () => {
    fc.assert(
      fc.property(fastestWithoutFareArb, (fastest) => {
        const result = buildComparison(fastest, null);

        expect(result.fareUnavailableForFastest).toBe(true);
        expect(result.fareDifferenceCents).toBeNull();
        // No economical side -> travel-time difference is not computable.
        expect(result.travelTimeDifferenceMinutes).toBeNull();
        expect(result.economical).toBeNull();
        expect(result.fastest).not.toBeNull();
        expect(result.fastest!.transferCount).toBe(fastest.transferCount);
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring example ------------------------------------------

  it('reports time difference but null fare difference for an unpriced fastest vs a priced economical', () => {
    const fastest = makeJourney({
      id: 'fastest',
      travelTimeMinutes: 30,
      transferCount: 1,
      modes: ['train', 'bus'],
      totalFare: null,
    });
    const economical = makeJourney({
      id: 'economical',
      travelTimeMinutes: 45,
      transferCount: 0,
      modes: ['bus'],
      totalFare: { amountCents: 420, currency: 'AUD' },
    });

    const result = buildComparison(fastest, economical);

    expect(result.fareUnavailableForFastest).toBe(true);
    expect(result.fareDifferenceCents).toBeNull();
    expect(result.travelTimeDifferenceMinutes).toBe(15);
    expect(result.cheaperRouteId).toBeNull();
    expect(result.fasterRouteId).toBe('fastest');
  });
});
