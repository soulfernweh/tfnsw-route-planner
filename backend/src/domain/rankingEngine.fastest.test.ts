import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { selectFastest } from './rankingEngine.js';
import type { Fare, Journey, Leg, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 7: Fastest selection minimises travel
// time then transfers
//
// Validates: Requirements 3.1
//
// `selectFastest(journeys)` must return a journey whose `travelTimeMinutes` is
// less than or equal to every other journey's (the global minimum travel time),
// and among all journeys sharing that minimum travel time, the chosen one must
// not have a strictly larger `transferCount` than any of them (i.e. it is the
// fewest-transfers tiebreak). For an empty list it returns `null`.

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

/** A minimal, structurally valid leg. Ranking ignores leg internals, but we
 * keep the shape honest so the generator produces real `Journey` values. */
function makeMinimalLeg(mode: TransportMode): Leg {
  const departureTime = '2020-01-01T08:00:00.000Z';
  const arrivalTime = '2020-01-01T08:30:00.000Z';
  return {
    origin: { locationName: 'Origin', platform: null, time: departureTime },
    destination: { locationName: 'Destination', platform: null, time: arrivalTime },
    mode,
    routeName: null,
    departureTime,
    arrivalTime,
    durationMinutes: 30,
    distanceMetres: null,
    isTransfer: mode === 'walk' || mode === 'bicycle',
    fare: null,
  };
}

const FARE_ARB: fc.Arbitrary<Fare | null> = fc.option(
  fc.record({
    amountCents: fc.integer({ min: 0, max: 100_000 }),
    currency: fc.constant<'AUD'>('AUD'),
  }),
  { nil: null },
);

/**
 * Generator for a single `Journey`. `travelTimeMinutes` and `transferCount`
 * (the only fields ranking depends on) are drawn from small ranges so ties
 * occur frequently, exercising the transfer tiebreak. `totalFare` varies
 * including null. Each journey gets a unique id supplied by the caller.
 */
function journeyArb(id: string): fc.Arbitrary<Journey> {
  return fc
    .record({
      travelTimeMinutes: fc.integer({ min: 0, max: 20 }),
      transferCount: fc.integer({ min: 0, max: 5 }),
      modes: fc.array(MODE_ARB, { minLength: 1, maxLength: 4 }),
      totalFare: FARE_ARB,
    })
    .map(({ travelTimeMinutes, transferCount, modes, totalFare }) => ({
      id,
      legs: [makeMinimalLeg(modes[0]!)],
      departureTime: '2020-01-01T08:00:00.000Z',
      arrivalTime: '2020-01-01T08:30:00.000Z',
      travelTimeMinutes,
      transferCount,
      modes,
      totalFare,
    }));
}

/** A non-empty list of journeys with guaranteed-unique ids. */
const nonEmptyJourneysArb: fc.Arbitrary<Journey[]> = fc
  .integer({ min: 1, max: 10 })
  .chain((n) =>
    fc.tuple(...Array.from({ length: n }, (_, i) => journeyArb(`j${i}`))),
  );

// --- Property 7 ------------------------------------------------------------

describe('selectFastest (Property 7)', () => {
  it('returns null for an empty list', () => {
    expect(selectFastest([])).toBeNull();
  });

  it('minimises travel time, then transfers among the fastest', () => {
    fc.assert(
      fc.property(nonEmptyJourneysArb, (journeys) => {
        const chosen = selectFastest(journeys);

        // A non-empty list always yields a chosen journey from the list.
        expect(chosen).not.toBeNull();
        expect(journeys).toContain(chosen!);

        // 1. Travel time is the global minimum.
        const minTravelTime = Math.min(
          ...journeys.map((j) => j.travelTimeMinutes),
        );
        expect(chosen!.travelTimeMinutes).toBe(minTravelTime);

        // 2. Among journeys sharing that minimum travel time, the chosen one
        //    has the fewest transfers (none is strictly smaller).
        const tied = journeys.filter(
          (j) => j.travelTimeMinutes === minTravelTime,
        );
        const minTransfersAmongTied = Math.min(
          ...tied.map((j) => j.transferCount),
        );
        expect(chosen!.transferCount).toBe(minTransfersAmongTied);
      }),
      { numRuns: 200 },
    );
  });

  // Concrete anchors for readability.
  it('prefers the lower travel time outright', () => {
    const journeys: Journey[] = [
      { ...baseJourney('a'), travelTimeMinutes: 30, transferCount: 0 },
      { ...baseJourney('b'), travelTimeMinutes: 25, transferCount: 3 },
    ];
    expect(selectFastest(journeys)!.id).toBe('b');
  });

  it('breaks ties on fewest transfers', () => {
    const journeys: Journey[] = [
      { ...baseJourney('a'), travelTimeMinutes: 25, transferCount: 2 },
      { ...baseJourney('b'), travelTimeMinutes: 25, transferCount: 1 },
    ];
    expect(selectFastest(journeys)!.id).toBe('b');
  });
});

/** Convenience builder for the concrete example journeys. */
function baseJourney(id: string): Journey {
  return {
    id,
    legs: [makeMinimalLeg('train')],
    departureTime: '2020-01-01T08:00:00.000Z',
    arrivalTime: '2020-01-01T08:30:00.000Z',
    travelTimeMinutes: 0,
    transferCount: 0,
    modes: ['train'],
    totalFare: null,
  };
}
