import { describe, it, expect } from 'vitest';

import { normaliseJourneys } from './normalise.js';

// Example-based tests for the leg-distance source used by fare estimation.
//
// The LIVE TfNSW trip response does NOT include a `leg.distance` field; each
// leg instead carries a `coords` polyline. These tests pin the normaliser's
// behaviour:
//   - when `leg.distance` is present, it is used directly;
//   - when `leg.distance` is absent, distance is derived from the `coords`
//     polyline (haversine sum) so the Opal fare calculator can still price the
//     leg (this is what makes the economical-route feature work against live
//     data).
//
// Validates: Requirements 4.2, 4.3 (per-leg Opal fare from distance + mode).

/** Build a minimal EFA trip payload wrapping a single train leg. */
function tripWithLeg(leg: Record<string, unknown>): { journeys: Array<{ legs: unknown[] }> } {
  return { journeys: [{ legs: [leg] }] };
}

/** A train leg (product.class 1) with stop times but the given extras. */
function trainLeg(extras: Record<string, unknown>): Record<string, unknown> {
  return {
    transportation: { product: { class: 1 }, disassembledName: 'T1' },
    duration: 600,
    origin: { name: 'A Station', departureTimePlanned: '2024-06-01T08:00:00Z' },
    destination: { name: 'B Station', arrivalTimePlanned: '2024-06-01T08:10:00Z' },
    ...extras,
  };
}

describe('leg distance source for fare estimation', () => {
  it('uses an explicit leg.distance when present (rail ≤20km band = 522c)', () => {
    const journeys = normaliseJourneys(tripWithLeg(trainLeg({ distance: 15000 })));
    expect(journeys).toHaveLength(1);
    const leg = journeys[0]!.legs[0]!;
    expect(leg.distanceMetres).toBe(15000);
    expect(leg.fare).toEqual({ amountCents: 522, currency: 'AUD' });
  });

  it('derives distance from the coords polyline when leg.distance is absent', () => {
    // Two points ~1.6 km apart (Central → Town Hall-ish). Haversine sum should
    // land well within the rail ≤10km band (420c), proving fares work without
    // an explicit distance field (the live API omits it).
    const coords: Array<[number, number]> = [
      [-33.8833, 151.2067],
      [-33.8731, 151.2069],
    ];
    const journeys = normaliseJourneys(tripWithLeg(trainLeg({ coords })));
    expect(journeys).toHaveLength(1);
    const leg = journeys[0]!.legs[0]!;
    expect(leg.distanceMetres).not.toBeNull();
    expect(leg.distanceMetres!).toBeGreaterThan(900);
    expect(leg.distanceMetres!).toBeLessThan(3000);
    // Short rail trip → ≤10km band = 420c.
    expect(leg.fare).toEqual({ amountCents: 420, currency: 'AUD' });
  });

  it('yields no distance (and no fare) when neither distance nor coords are present', () => {
    const journeys = normaliseJourneys(tripWithLeg(trainLeg({})));
    expect(journeys).toHaveLength(1);
    const leg = journeys[0]!.legs[0]!;
    expect(leg.distanceMetres).toBeNull();
    expect(leg.fare).toBeNull();
  });
});
