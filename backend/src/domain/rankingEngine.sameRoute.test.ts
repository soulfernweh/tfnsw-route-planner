import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { buildComparison } from './rankingEngine.js';
import type { Fare, Journey, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 12: Coinciding fastest and economical
// collapse to a single route
//
// Validates: Requirements 5.4
//
// When one journey is SIMULTANEOUSLY the fastest and the most economical
// selection, `buildComparison` is invoked with the SAME journey object as both
// the `fastest` and `economical` argument. In that situation the comparison
// must collapse to a single route:
//  - `sameRoute === true`
//  - `travelTimeDifferenceMinutes === 0` (a route differs from itself by 0)
//  - `fareDifferenceCents === 0` when the journey is priced, or `null` when the
//    journey has no fare (nothing to difference)
//  - `fasterRouteId` points to that journey's id
//  - `cheaperRouteId` points to that journey's id ONLY when the journey is
//    priced (an unpriced journey is never labelled the cheaper route)

const MS_PER_MINUTE = 60_000;

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

/** An adult Opal fare in integer cents (>= 0), or null (unpriced journey). */
const FARE_OR_NULL_ARB: fc.Arbitrary<Fare | null> = fc.option(
  fc.integer({ min: 0, max: 100_000 }).map(
    (amountCents) => ({ amountCents, currency: 'AUD' as const }),
  ),
  { nil: null },
);

/**
 * Generate a single, internally-consistent `Journey` with varied travel time,
 * transfer count, modes, and fare (including the unpriced `null` case). The leg
 * list is a minimal placeholder; `buildComparison` only reads `id`,
 * `travelTimeMinutes`, `totalFare`, `transferCount`, and `modes`.
 */
const journeyArb: fc.Arbitrary<Journey> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 24 }),
    travelTimeMinutes: fc.integer({ min: 0, max: 1_440 }),
    transferCount: fc.integer({ min: 0, max: 6 }),
    modes: fc.array(MODE_ARB, { minLength: 1, maxLength: 4 }),
    totalFare: FARE_OR_NULL_ARB,
  })
  .map(({ id, travelTimeMinutes, transferCount, modes, totalFare }) => {
    const departureTime = '2020-01-01T08:00:00.000Z';
    const arrivalTime = new Date(
      Date.parse(departureTime) + travelTimeMinutes * MS_PER_MINUTE,
    ).toISOString();
    const journey: Journey = {
      id,
      legs: [
        {
          origin: { locationName: 'Origin', platform: null, time: departureTime },
          destination: {
            locationName: 'Destination',
            platform: null,
            time: arrivalTime,
          },
          mode: modes[0]!,
          routeName: null,
          departureTime,
          arrivalTime,
          durationMinutes: travelTimeMinutes,
          distanceMetres: null,
          isTransfer: false,
          fare: totalFare,
        },
      ],
      departureTime,
      arrivalTime,
      travelTimeMinutes,
      transferCount,
      modes,
      totalFare,
    };
    return journey;
  });

describe('buildComparison collapses to a single route (Property 12)', () => {
  it('sets sameRoute and zero/null differences when one journey is both fastest and economical', () => {
    fc.assert(
      fc.property(journeyArb, (journey) => {
        // The same journey object is simultaneously fastest and economical.
        const comparison = buildComparison(journey, journey);

        // Collapses to a single route.
        expect(comparison.sameRoute).toBe(true);

        // A route never differs from itself in travel time.
        expect(comparison.travelTimeDifferenceMinutes).toBe(0);

        // The single journey is the faster route.
        expect(comparison.fasterRouteId).toBe(journey.id);

        // Both entries describe the same journey.
        expect(comparison.fastest).not.toBeNull();
        expect(comparison.economical).not.toBeNull();
        expect(comparison.fastest!.journeyId).toBe(journey.id);
        expect(comparison.economical!.journeyId).toBe(journey.id);

        if (journey.totalFare === null) {
          // Unpriced: no fare difference and not labelled the cheaper route.
          expect(comparison.fareDifferenceCents).toBeNull();
          expect(comparison.cheaperRouteId).toBeNull();
          // Fastest journey having no fare is flagged.
          expect(comparison.fareUnavailableForFastest).toBe(true);
        } else {
          // Priced: zero fare difference and the journey is the cheaper route.
          expect(comparison.fareDifferenceCents).toBe(0);
          expect(comparison.cheaperRouteId).toBe(journey.id);
          expect(comparison.fareUnavailableForFastest).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('collapses a priced journey to a single route with zero differences', () => {
    const journey: Journey = {
      id: 'j-priced',
      legs: [],
      departureTime: '2020-01-01T08:00:00.000Z',
      arrivalTime: '2020-01-01T08:30:00.000Z',
      travelTimeMinutes: 30,
      transferCount: 1,
      modes: ['train'],
      totalFare: { amountCents: 420, currency: 'AUD' },
    };

    const comparison = buildComparison(journey, journey);

    expect(comparison.sameRoute).toBe(true);
    expect(comparison.travelTimeDifferenceMinutes).toBe(0);
    expect(comparison.fareDifferenceCents).toBe(0);
    expect(comparison.fasterRouteId).toBe('j-priced');
    expect(comparison.cheaperRouteId).toBe('j-priced');
    expect(comparison.fareUnavailableForFastest).toBe(false);
  });

  it('collapses an unpriced journey to a single route with null fare handling', () => {
    const journey: Journey = {
      id: 'j-unpriced',
      legs: [],
      departureTime: '2020-01-01T08:00:00.000Z',
      arrivalTime: '2020-01-01T08:15:00.000Z',
      travelTimeMinutes: 15,
      transferCount: 0,
      modes: ['walk'],
      totalFare: null,
    };

    const comparison = buildComparison(journey, journey);

    expect(comparison.sameRoute).toBe(true);
    expect(comparison.travelTimeDifferenceMinutes).toBe(0);
    expect(comparison.fareDifferenceCents).toBeNull();
    expect(comparison.fasterRouteId).toBe('j-unpriced');
    expect(comparison.cheaperRouteId).toBeNull();
    expect(comparison.fareUnavailableForFastest).toBe(true);
  });
});
