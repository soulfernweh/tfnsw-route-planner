import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { selectEconomical } from './rankingEngine.js';
import type { Fare, Journey, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 9: Economical selection minimises fare
// among priced routes and excludes unpriced routes
//
// Validates: Requirements 4.1, 4.4
//
// `selectEconomical(journeys)` chooses the cheapest priced journey:
//  - Only journeys with a non-null `totalFare` are eligible; null-fare journeys
//    are EXCLUDED entirely (Req 4.4).
//  - Primary ranking: minimum `totalFare.amountCents` (Req 4.1).
//  - Tiebreak: among priced journeys sharing that minimum fare, the one with
//    the shortest `travelTimeMinutes`.
//  - When no journey is priced (all null fares, or the list is empty), returns
//    `null`.
//
// The generators below build a mix of priced and null-fare journeys so the
// selection logic is exercised across the full input space.

// --- Generators ------------------------------------------------------------

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

/**
 * Build a minimal, valid `Journey`. Only the fields used by `selectEconomical`
 * (`id`, `totalFare`, `travelTimeMinutes`) carry meaningful values; the rest are
 * valid placeholders. `id` is forced unique by the caller via the index.
 */
function makeJourney(
  id: string,
  totalFare: Fare | null,
  travelTimeMinutes: number,
): Journey {
  const departureTime = '2020-01-01T08:00:00.000Z';
  const arrivalTime = '2020-01-01T08:30:00.000Z';
  return {
    id,
    legs: [
      {
        origin: { locationName: 'Origin', platform: null, time: departureTime },
        destination: {
          locationName: 'Destination',
          platform: null,
          time: arrivalTime,
        },
        mode: 'train',
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
    transferCount: 0,
    modes: ['train'],
    totalFare,
  };
}

/**
 * A list of journeys with a mix of priced and null-fare entries. Each journey
 * gets a unique id (its index) so selection can be identified unambiguously.
 */
const journeyListArb: fc.Arbitrary<Journey[]> = fc
  .array(
    fc.record({
      fare: fc.option(FARE_ARB, { nil: null }),
      travelTimeMinutes: fc.integer({ min: 0, max: 600 }),
      modes: fc.array(MODE_ARB, { minLength: 1, maxLength: 4 }),
    }),
    { maxLength: 12 },
  )
  .map((specs) =>
    specs.map((s, i) => makeJourney(`j${i}`, s.fare, s.travelTimeMinutes)),
  );

// --- Property 9 ------------------------------------------------------------

describe('selectEconomical (Property 9)', () => {
  it('returns a priced journey that minimises fare, with shortest travel time among ties, never an unpriced journey', () => {
    fc.assert(
      fc.property(journeyListArb, (journeys) => {
        const result = selectEconomical(journeys);

        const priced = journeys.filter((j) => j.totalFare !== null);

        if (priced.length === 0) {
          // No priced journeys -> must return null (Req 4.4).
          expect(result).toBeNull();
          return;
        }

        // A priced journey must be selected, and it must be one of the inputs.
        expect(result).not.toBeNull();
        expect(result!.totalFare).not.toBeNull();
        expect(journeys).toContain(result!);

        const chosenFare = result!.totalFare!.amountCents;

        // Minimises fare among all priced journeys (Req 4.1).
        const minFare = Math.min(
          ...priced.map((j) => j.totalFare!.amountCents),
        );
        expect(chosenFare).toBe(minFare);
        for (const j of priced) {
          expect(chosenFare).toBeLessThanOrEqual(j.totalFare!.amountCents);
        }

        // Among journeys sharing the minimum fare, none has a strictly shorter
        // travel time than the chosen one (tiebreak).
        const tied = priced.filter(
          (j) => j.totalFare!.amountCents === chosenFare,
        );
        for (const j of tied) {
          expect(j.travelTimeMinutes).toBeGreaterThanOrEqual(
            result!.travelTimeMinutes,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never selects an unpriced journey even when one would be cheaper by virtue of having no fare', () => {
    // Mix where some null-fare journeys have very short travel times — they must
    // still be excluded.
    const arb = fc
      .array(
        fc.record({
          priced: fc.boolean(),
          fare: fc.integer({ min: 0, max: 100_000 }),
          travelTimeMinutes: fc.integer({ min: 0, max: 600 }),
        }),
        { minLength: 1, maxLength: 10 },
      )
      .map((specs) =>
        specs.map((s, i) =>
          makeJourney(
            `j${i}`,
            s.priced ? { amountCents: s.fare, currency: 'AUD' } : null,
            s.travelTimeMinutes,
          ),
        ),
      );

    fc.assert(
      fc.property(arb, (journeys) => {
        const result = selectEconomical(journeys);
        if (result !== null) {
          expect(result.totalFare).not.toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('returns null for an empty list', () => {
    expect(selectEconomical([])).toBeNull();
  });

  it('returns null when all journeys are unpriced', () => {
    const journeys = [
      makeJourney('a', null, 10),
      makeJourney('b', null, 5),
    ];
    expect(selectEconomical(journeys)).toBeNull();
  });

  it('picks the cheapest priced journey, ignoring a cheaper-looking unpriced one', () => {
    const journeys = [
      makeJourney('unpriced', null, 1),
      makeJourney('cheap', { amountCents: 250, currency: 'AUD' }, 40),
      makeJourney('pricey', { amountCents: 500, currency: 'AUD' }, 20),
    ];
    expect(selectEconomical(journeys)!.id).toBe('cheap');
  });

  it('breaks fare ties by shortest travel time', () => {
    const journeys = [
      makeJourney('slow', { amountCents: 300, currency: 'AUD' }, 50),
      makeJourney('fast', { amountCents: 300, currency: 'AUD' }, 20),
    ];
    expect(selectEconomical(journeys)!.id).toBe('fast');
  });
});
