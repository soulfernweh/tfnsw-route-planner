import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { RouteService, type RoutePlanningClient } from './routeService.js';
import type { Journey, Leg, SelectableMode } from '../domain/models.js';

// Feature: tfnsw-route-planner, Property 4: Journey window is ordered, de-duplicated, and includes earlier trips
//
// Validates: Requirements 2.2
//
// `RouteService.planRoutes` issues TWO `trip` queries around the Selected_Time
// (a forward query in the request's `depArr` direction, and an
// opposite-direction query that supplies the earlier/later half of the window),
// then MERGES the two journey lists. The merge:
//   (a) orders the result by NON-DECREASING `departureTime`;
//   (b) DE-DUPLICATES by the stable signature
//       `(first leg origin.locationName, last leg destination.locationName,
//         departureTime, arrivalTime)` — the trip API supplies no journey id;
//   (c) drops NOTHING: the merged set equals the UNION of unique input
//       signatures, and every merged journey came from one of the two lists.
//
// To exercise this we inject a fake `RoutePlanningClient` whose `trip` returns a
// configured "forward" list for the request's `depArr` and an "earlier/opposite"
// list for the opposite `depArr`. The generator deliberately seeds OVERLAPPING
// signatures across the two lists (and within them) so the de-duplication path
// is hit, while distinct seeds keep distinct signatures so no real journey is
// ever wrongly collapsed.

const MS_PER_MINUTE = 60_000;
const BASE_EPOCH_MS = Date.parse('2025-01-01T00:00:00Z');

/** Convert a minute-offset from the base epoch into an ISO 8601 UTC string. */
function isoAt(offsetMinutes: number): string {
  return new Date(BASE_EPOCH_MS + offsetMinutes * MS_PER_MINUTE).toISOString();
}

/** The signature the Route Service de-duplicates on (mirrors routeService.ts). */
function signatureOf(journey: Journey): string {
  const firstLeg = journey.legs[0]!;
  const lastLeg = journey.legs[journey.legs.length - 1]!;
  return [
    firstLeg.origin.locationName,
    lastLeg.destination.locationName,
    journey.departureTime,
    journey.arrivalTime,
  ].join('\u241F');
}

/**
 * A "seed" fully determines a journey's signature: its first-leg origin name,
 * last-leg destination name, and journey departure/arrival times. Two journeys
 * built from the same seed share a signature (and must collapse on merge);
 * journeys from different seeds have distinct signatures (the seed index is
 * baked into the names, so they never collide).
 */
interface Seed {
  index: number;
  depMinutes: number;
  arrMinutes: number;
}

/**
 * Build a minimal but complete `Journey` fixture from a seed. Uses two legs so
 * the signature genuinely exercises "first leg origin" + "last leg destination"
 * (the intermediate stop name is irrelevant to the signature). The `id` is
 * caller-supplied and intentionally NOT part of the signature.
 */
function makeJourney(seed: Seed, id: string): Journey {
  const originName = `O${seed.index}`;
  const destName = `D${seed.index}`;
  const midName = `M${seed.index}`;
  const departureTime = isoAt(seed.depMinutes);
  const arrivalTime = isoAt(seed.arrMinutes);
  const travelTimeMinutes = seed.arrMinutes - seed.depMinutes;

  const leg1: Leg = {
    origin: { locationName: originName, platform: null, time: departureTime },
    destination: { locationName: midName, platform: null, time: arrivalTime },
    mode: 'train',
    routeName: 'T1',
    departureTime,
    arrivalTime,
    durationMinutes: travelTimeMinutes,
    distanceMetres: 5000,
    isTransfer: false,
    fare: null,
  };
  const leg2: Leg = {
    origin: { locationName: midName, platform: null, time: arrivalTime },
    destination: { locationName: destName, platform: null, time: arrivalTime },
    mode: 'bus',
    routeName: '389',
    departureTime: arrivalTime,
    arrivalTime,
    durationMinutes: 0,
    distanceMetres: 1000,
    isTransfer: false,
    fare: null,
  };

  return {
    id,
    legs: [leg1, leg2],
    departureTime,
    arrivalTime,
    travelTimeMinutes,
    transferCount: 1,
    modes: ['train', 'bus'],
    totalFare: null,
  };
}

/**
 * A fake client that returns a preconfigured FORWARD list for the request's
 * `depArr` and an OPPOSITE list for the other direction. This isolates the
 * Route Service merge logic from any real upstream behaviour.
 */
function makeFakeClient(
  requestDepArr: 'dep' | 'arr',
  forward: Journey[],
  opposite: Journey[],
): RoutePlanningClient {
  return {
    async trip(params: {
      originId: string;
      destinationId: string;
      time: Date;
      depArr: 'dep' | 'arr';
      calcNumberOfTrips?: number;
      excludedModes?: SelectableMode[];
    }): Promise<Journey[]> {
      return params.depArr === requestDepArr ? forward : opposite;
    },
  };
}

/**
 * Generate a shared pool of seeds plus the index lists used to build the
 * forward and opposite journey lists. Reusing an index across (or within) the
 * two lists produces overlapping signatures, exercising de-duplication; the
 * baked-in seed index keeps distinct seeds' signatures distinct.
 */
const SCENARIO_ARB = fc
  .record({
    // 1..8 distinct seeds; each seed's times spread across a wide window.
    seedSpecs: fc.array(
      fc.record({
        depMinutes: fc.integer({ min: 0, max: 7 * 24 * 60 }),
        durationMinutes: fc.integer({ min: 1, max: 240 }),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  })
  .chain(({ seedSpecs }) => {
    const seeds: Seed[] = seedSpecs.map((spec, index) => ({
      index,
      depMinutes: spec.depMinutes,
      arrMinutes: spec.depMinutes + spec.durationMinutes,
    }));
    const indexArb = fc.integer({ min: 0, max: seeds.length - 1 });
    return fc.record({
      seeds: fc.constant(seeds),
      // Index lists may repeat (within-list duplicates) and overlap (cross-list
      // duplicates) so the de-duplication path is regularly exercised.
      forwardIndices: fc.array(indexArb, { minLength: 0, maxLength: 10 }),
      oppositeIndices: fc.array(indexArb, { minLength: 0, maxLength: 10 }),
    });
  });

describe('RouteService merged journey window (Property 4)', () => {
  it('is ordered, de-duplicated, and the union of all unique input signatures', async () => {
    await fc.assert(
      fc.asyncProperty(SCENARIO_ARB, async ({ seeds, forwardIndices, oppositeIndices }) => {
        const forward = forwardIndices.map((i, k) => makeJourney(seeds[i]!, `F${k}`));
        const opposite = oppositeIndices.map((i, k) => makeJourney(seeds[i]!, `R${k}`));

        const client = makeFakeClient('dep', forward, opposite);
        const service = new RouteService(client);

        const result = await service.planRoutes({
          originId: 'A',
          destinationId: 'B',
          time: isoAt(0),
          depArr: 'dep',
          includedModes: [],
        });

        const journeys = result.journeys;

        // (a) ordered by non-decreasing departureTime.
        for (let i = 1; i < journeys.length; i += 1) {
          const prev = Date.parse(journeys[i - 1]!.departureTime);
          const curr = Date.parse(journeys[i]!.departureTime);
          expect(prev).toBeLessThanOrEqual(curr);
        }

        // (b) no two journeys share a signature.
        const resultSignatures = journeys.map(signatureOf);
        expect(new Set(resultSignatures).size).toBe(resultSignatures.length);

        // (c) the merged set equals the union of unique input signatures, and
        // every merged journey is a reference from one of the two input lists.
        const unionSignatures = new Set(
          [...forward, ...opposite].map(signatureOf),
        );
        expect(new Set(resultSignatures)).toEqual(unionSignatures);
        expect(journeys.length).toBe(unionSignatures.size);
        for (const j of journeys) {
          expect(forward.includes(j) || opposite.includes(j)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Focused example: the ">= 5 earlier trips" guarantee (Req 2.2) --------

  it('includes at least 5 earlier trips when the opposite-direction query offers them', async () => {
    // Forward list: trips departing at/after the Selected_Time (offset 600+).
    const forward: Journey[] = [
      makeJourney({ index: 100, depMinutes: 600, arrMinutes: 660 }, 'F0'),
      makeJourney({ index: 101, depMinutes: 615, arrMinutes: 680 }, 'F1'),
      makeJourney({ index: 102, depMinutes: 630, arrMinutes: 700 }, 'F2'),
    ];
    const forwardEarliest = Math.min(
      ...forward.map((j) => Date.parse(j.departureTime)),
    );

    // Opposite (arrive-by) list: 5 distinct earlier trips, all departing before
    // the forward set's earliest departure.
    const opposite: Journey[] = [
      makeJourney({ index: 1, depMinutes: 480, arrMinutes: 540 }, 'R0'),
      makeJourney({ index: 2, depMinutes: 500, arrMinutes: 560 }, 'R1'),
      makeJourney({ index: 3, depMinutes: 520, arrMinutes: 580 }, 'R2'),
      makeJourney({ index: 4, depMinutes: 540, arrMinutes: 595 }, 'R3'),
      makeJourney({ index: 5, depMinutes: 560, arrMinutes: 599 }, 'R4'),
    ];

    const client = makeFakeClient('dep', forward, opposite);
    const service = new RouteService(client);

    const result = await service.planRoutes({
      originId: 'A',
      destinationId: 'B',
      time: isoAt(600),
      depArr: 'dep',
      includedModes: [],
    });

    const earlierCount = result.journeys.filter(
      (j) => Date.parse(j.departureTime) < forwardEarliest,
    ).length;
    expect(earlierCount).toBeGreaterThanOrEqual(5);

    // And the window is still ordered and complete (3 forward + 5 earlier = 8).
    expect(result.journeys.length).toBe(8);
    for (let i = 1; i < result.journeys.length; i += 1) {
      expect(Date.parse(result.journeys[i - 1]!.departureTime)).toBeLessThanOrEqual(
        Date.parse(result.journeys[i]!.departureTime),
      );
    }
  });

  it('collapses a signature shared across the forward and opposite lists', async () => {
    const shared: Seed = { index: 7, depMinutes: 300, arrMinutes: 360 };
    const forward = [makeJourney(shared, 'F0'), makeJourney({ index: 8, depMinutes: 400, arrMinutes: 450 }, 'F1')];
    // Same seed -> same signature as forward[0], so it must be de-duplicated.
    const opposite = [makeJourney(shared, 'R0'), makeJourney({ index: 9, depMinutes: 100, arrMinutes: 150 }, 'R1')];

    const client = makeFakeClient('dep', forward, opposite);
    const service = new RouteService(client);

    const result = await service.planRoutes({
      originId: 'A',
      destinationId: 'B',
      time: isoAt(300),
      depArr: 'dep',
      includedModes: [],
    });

    // 4 inputs, one duplicate signature -> 3 unique journeys.
    expect(result.journeys.length).toBe(3);
    // The first occurrence (from the forward list) is the one retained.
    const retained = result.journeys.find((j) => signatureOf(j) === signatureOf(forward[0]!));
    expect(retained).toBe(forward[0]);
  });
});
