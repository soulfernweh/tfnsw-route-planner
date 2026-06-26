import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildComparison } from './rankingEngine.js';
import type { Fare, Journey, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 10: Comparison differences and
// faster/cheaper labels are consistent
//
// Validates: Requirements 5.3
//
// For any two journeys (a fastest and an economical), `buildComparison`:
//  - reports `travelTimeDifferenceMinutes` equal to the absolute difference of
//    their travel times,
//  - reports `fareDifferenceCents` equal to the absolute difference of their
//    fares, or `null` when either fare is missing,
//  - labels `fasterRouteId` as the journey with the lower travel time and
//    `cheaperRouteId` as the journey with the lower fare.
//
// Tie handling (per the implementation contract): ties on travel time resolve
// to the fastest journey, and ties on fare resolve to the economical journey.

// --- Helpers ---------------------------------------------------------------

const MODE_ARB: fc.Arbitrary<TransportMode> = fc.constantFrom(
  'train',
  'metro',
  'bus',
  'ferry',
  'lightRail',
  'coach',
  'walk',
  'school',
  'other',
);

/** An adult Opal fare in integer cents (>= 0), or null (unpriced). */
const OPTIONAL_FARE_ARB: fc.Arbitrary<Fare | null> = fc.option(
  fc
    .integer({ min: 0, max: 100_000 })
    .map((amountCents) => ({ amountCents, currency: 'AUD' as const })),
  { nil: null },
);

/**
 * Build a minimal, valid `Journey` carrying only the fields `buildComparison`
 * reads: `id`, `travelTimeMinutes`, `transferCount`, `modes`, and `totalFare`.
 * The remaining required fields are filled with valid placeholders.
 */
function makeJourney(
  id: string,
  travelTimeMinutes: number,
  transferCount: number,
  modes: TransportMode[],
  totalFare: Fare | null,
): Journey {
  const departureTime = '2020-01-01T08:00:00.000Z';
  const arrivalTime = '2020-01-01T09:00:00.000Z';
  return {
    id,
    legs: [],
    departureTime,
    arrivalTime,
    travelTimeMinutes,
    transferCount,
    modes,
    totalFare,
  };
}

/**
 * Generator for a pair of journeys with DISTINCT ids, varied travel times,
 * varied transfer counts, and total fares (including null). The first element
 * plays the "fastest" role and the second the "economical" role in
 * `buildComparison`; the property holds regardless of whether their values
 * actually make them the genuine fastest/economical selections, because
 * `buildComparison` performs no ranking itself.
 */
const journeyPairArb: fc.Arbitrary<{ fastest: Journey; economical: Journey }> =
  fc
    .record({
      idA: fc.string({ minLength: 1, maxLength: 12 }),
      idBSuffix: fc.string({ minLength: 1, maxLength: 12 }),
      ttA: fc.integer({ min: 0, max: 600 }),
      ttB: fc.integer({ min: 0, max: 600 }),
      trA: fc.integer({ min: 0, max: 8 }),
      trB: fc.integer({ min: 0, max: 8 }),
      modesA: fc.array(MODE_ARB, { maxLength: 5 }),
      modesB: fc.array(MODE_ARB, { maxLength: 5 }),
      fareA: OPTIONAL_FARE_ARB,
      fareB: OPTIONAL_FARE_ARB,
    })
    .map((r) => {
      // Guarantee distinct ids by giving B a guaranteed-different value.
      const idA = r.idA;
      const idB = `${r.idA}-${r.idBSuffix}#B`;
      return {
        fastest: makeJourney(idA, r.ttA, r.trA, r.modesA, r.fareA),
        economical: makeJourney(idB, r.ttB, r.trB, r.modesB, r.fareB),
      };
    });

// --- Property 10 -----------------------------------------------------------

describe('buildComparison differences and labels (Property 10)', () => {
  it('reports differences and faster/cheaper labels consistently for any two journeys', () => {
    fc.assert(
      fc.property(journeyPairArb, ({ fastest, economical }) => {
        const comparison = buildComparison(fastest, economical);

        // Travel-time difference is the absolute difference of travel times.
        expect(comparison.travelTimeDifferenceMinutes).toBe(
          Math.abs(fastest.travelTimeMinutes - economical.travelTimeMinutes),
        );

        // faster label points at the journey with the lower travel time; ties
        // resolve to the fastest journey.
        const expectedFasterId =
          fastest.travelTimeMinutes <= economical.travelTimeMinutes
            ? fastest.id
            : economical.id;
        expect(comparison.fasterRouteId).toBe(expectedFasterId);

        if (fastest.totalFare !== null && economical.totalFare !== null) {
          // Both priced: fare difference is the absolute difference of fares.
          expect(comparison.fareDifferenceCents).toBe(
            Math.abs(
              fastest.totalFare.amountCents - economical.totalFare.amountCents,
            ),
          );

          // cheaper label points at the journey with the lower fare; ties
          // resolve to the economical journey.
          const expectedCheaperId =
            economical.totalFare.amountCents <= fastest.totalFare.amountCents
              ? economical.id
              : fastest.id;
          expect(comparison.cheaperRouteId).toBe(expectedCheaperId);
        } else {
          // Either fare missing: difference and cheaper label are null.
          expect(comparison.fareDifferenceCents).toBeNull();
          expect(comparison.cheaperRouteId).toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('labels the lower-travel-time journey as faster and the lower-fare as cheaper', () => {
    const fastest = makeJourney('fast', 30, 0, ['train'], {
      amountCents: 500,
      currency: 'AUD',
    });
    const economical = makeJourney('econ', 45, 1, ['bus'], {
      amountCents: 320,
      currency: 'AUD',
    });

    const comparison = buildComparison(fastest, economical);

    expect(comparison.travelTimeDifferenceMinutes).toBe(15);
    expect(comparison.fareDifferenceCents).toBe(180);
    expect(comparison.fasterRouteId).toBe('fast');
    expect(comparison.cheaperRouteId).toBe('econ');
  });

  it('returns null fare difference and cheaper label when the fastest fare is missing', () => {
    const fastest = makeJourney('fast', 30, 0, ['train'], null);
    const economical = makeJourney('econ', 45, 1, ['bus'], {
      amountCents: 320,
      currency: 'AUD',
    });

    const comparison = buildComparison(fastest, economical);

    expect(comparison.travelTimeDifferenceMinutes).toBe(15);
    expect(comparison.fareDifferenceCents).toBeNull();
    expect(comparison.cheaperRouteId).toBeNull();
    expect(comparison.fasterRouteId).toBe('fast');
  });
});
