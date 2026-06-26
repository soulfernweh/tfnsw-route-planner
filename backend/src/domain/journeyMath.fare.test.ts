import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { sumLegFares, isFareBearingLeg } from './journeyMath.js';
import type { Fare, Leg, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 8: Total fare equals the sum of leg
// fares
//
// Validates: Requirements 4.2
//
// `sumLegFares(legs)` aggregates per-leg fares into a journey's `totalFare`:
//  - For any journey whose fare-bearing legs ALL carry fare data, the result's
//    `amountCents` equals the sum of the `amountCents` of the legs that carry a
//    fare.
//  - A fare-bearing leg missing its fare yields a `null` total (the journey is
//    not fully priced).
//  - Non-fare-bearing connector legs (walk / transfer) without a fare do NOT
//    force a `null` total; they simply contribute nothing.
//
// A leg is fare-bearing exactly when `!isTransfer && mode !== 'walk'`, so the
// generators below are aligned with `isFareBearingLeg`.

// --- Helpers ---------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

/** Modes that are NOT 'walk' — eligible to be fare-bearing vehicle rides. */
const VEHICLE_MODE_ARB: fc.Arbitrary<TransportMode> = fc.constantFrom(
  'train',
  'metro',
  'bus',
  'ferry',
  'lightRail',
  'coach',
  'school',
  'other',
);

/** An adult Opal fare in integer cents (>= 0). */
const FARE_ARB: fc.Arbitrary<Fare> = fc
  .integer({ min: 0, max: 100_000 })
  .map((amountCents) => ({ amountCents, currency: 'AUD' as const }));

/** Build a minimal, valid `Leg`. Times are placeholders; fare math ignores them. */
function makeLeg(mode: TransportMode, isTransfer: boolean, fare: Fare | null): Leg {
  const departureTime = '2020-01-01T08:00:00.000Z';
  const arrivalTime = '2020-01-01T08:10:00.000Z';
  return {
    origin: { locationName: 'Origin', platform: null, time: departureTime },
    destination: { locationName: 'Destination', platform: null, time: arrivalTime },
    mode,
    routeName: null,
    departureTime,
    arrivalTime,
    durationMinutes: (Date.parse(arrivalTime) - Date.parse(departureTime)) / MS_PER_MINUTE,
    isTransfer,
    fare,
  };
}

/**
 * Generator for a fully-priced journey: every fare-bearing leg carries a fare,
 * and connector legs (walk/transfer) may or may not carry a fare. Guarantees at
 * least one fare-bearing leg so the result is non-null.
 *
 * Yields `{ legs, expectedCents }` where `expectedCents` is the independent
 * ground-truth sum of the `amountCents` of EVERY leg that carries a fare
 * (matching the implementation, which sums any present leg fare defensively).
 */
const fullyPricedJourneyArb: fc.Arbitrary<{ legs: Leg[]; expectedCents: number }> = fc
  .record({
    // At least one fare-bearing (vehicle) leg, each with a fare.
    vehicleLegs: fc.array(
      fc.record({ mode: VEHICLE_MODE_ARB, fare: FARE_ARB }),
      { minLength: 1, maxLength: 6 },
    ),
    // Connector legs: walk/transfer; fare optionally present.
    connectorLegs: fc.array(
      fc.record({
        mode: fc.constantFrom<TransportMode>('walk', 'train', 'bus', 'ferry'),
        // Force these to be connectors via isTransfer or walk mode below.
        useWalk: fc.boolean(),
        fare: fc.option(FARE_ARB, { nil: null }),
      }),
      { maxLength: 4 },
    ),
  })
  .map(({ vehicleLegs, connectorLegs }) => {
    const legs: Leg[] = [];
    let expectedCents = 0;

    for (const v of vehicleLegs) {
      legs.push(makeLeg(v.mode, false, v.fare));
      expectedCents += v.fare.amountCents;
    }

    for (const c of connectorLegs) {
      // Make it a connector either by walk mode or by isTransfer flag — both
      // make isFareBearingLeg false.
      const mode: TransportMode = c.useWalk ? 'walk' : c.mode;
      const isTransfer = !c.useWalk; // non-walk connector marked as transfer
      const leg = makeLeg(mode, isTransfer, c.fare);
      // Defensive: ensure this leg is genuinely non-fare-bearing.
      if (!isFareBearingLeg(leg)) {
        legs.push(leg);
        if (c.fare !== null) {
          expectedCents += c.fare.amountCents;
        }
      }
    }

    // Interleave connectors among vehicle legs deterministically by rotating,
    // so order varies without affecting the sum.
    return { legs, expectedCents };
  });

// --- Property 8 ------------------------------------------------------------

describe('sumLegFares (Property 8)', () => {
  it('equals the sum of the fares of legs that carry a fare, for fully-priced journeys', () => {
    fc.assert(
      fc.property(fullyPricedJourneyArb, ({ legs, expectedCents }) => {
        const total = sumLegFares(legs);

        expect(total).not.toBeNull();
        expect(total!.currency).toBe('AUD');
        expect(total!.amountCents).toBe(expectedCents);

        // Cross-check against an independent re-sum of present leg fares.
        const independent = legs.reduce(
          (acc, leg) => acc + (leg.fare?.amountCents ?? 0),
          0,
        );
        expect(total!.amountCents).toBe(independent);
      }),
      { numRuns: 200 },
    );
  });

  it('returns null when any fare-bearing leg is missing its fare', () => {
    // Build a fully-priced journey, then drop the fare on one fare-bearing leg.
    const arb = fullyPricedJourneyArb.chain(({ legs }) => {
      const fareBearingIndices = legs
        .map((leg, i) => (isFareBearingLeg(leg) ? i : -1))
        .filter((i) => i >= 0);
      return fc
        .constantFrom(...fareBearingIndices)
        .map((dropIndex) => {
          const mutated = legs.map((leg, i) =>
            i === dropIndex ? { ...leg, fare: null } : leg,
          );
          return mutated;
        });
    });

    fc.assert(
      fc.property(arb, (legs) => {
        expect(sumLegFares(legs)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('does not force null when only non-fare-bearing connector legs lack a fare', () => {
    // At least one priced vehicle leg, plus connector legs that all lack fare.
    const arb = fc
      .record({
        vehicleLegs: fc.array(
          fc.record({ mode: VEHICLE_MODE_ARB, fare: FARE_ARB }),
          { minLength: 1, maxLength: 5 },
        ),
        connectorCount: fc.integer({ min: 0, max: 4 }),
        connectorsAreWalk: fc.array(fc.boolean(), { maxLength: 4 }),
      })
      .map(({ vehicleLegs, connectorCount, connectorsAreWalk }) => {
        const legs: Leg[] = [];
        let expectedCents = 0;
        for (const v of vehicleLegs) {
          legs.push(makeLeg(v.mode, false, v.fare));
          expectedCents += v.fare.amountCents;
        }
        for (let i = 0; i < connectorCount; i++) {
          const isWalk = connectorsAreWalk[i] ?? true;
          // walk connector, or non-walk leg flagged as transfer — both non-fare-bearing.
          legs.push(makeLeg(isWalk ? 'walk' : 'bus', !isWalk, null));
        }
        return { legs, expectedCents };
      });

    fc.assert(
      fc.property(arb, ({ legs, expectedCents }) => {
        const total = sumLegFares(legs);
        expect(total).not.toBeNull();
        expect(total!.amountCents).toBe(expectedCents);
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('sums two priced vehicle legs', () => {
    const legs = [
      makeLeg('train', false, { amountCents: 380, currency: 'AUD' }),
      makeLeg('bus', false, { amountCents: 250, currency: 'AUD' }),
    ];
    expect(sumLegFares(legs)).toEqual({ amountCents: 630, currency: 'AUD' });
  });

  it('ignores a fareless walk connector between two priced legs', () => {
    const legs = [
      makeLeg('train', false, { amountCents: 380, currency: 'AUD' }),
      makeLeg('walk', true, null),
      makeLeg('bus', false, { amountCents: 250, currency: 'AUD' }),
    ];
    expect(sumLegFares(legs)).toEqual({ amountCents: 630, currency: 'AUD' });
  });

  it('returns null for a walk-only journey (no fare-bearing legs)', () => {
    const legs = [makeLeg('walk', true, null)];
    expect(sumLegFares(legs)).toBeNull();
  });
});
