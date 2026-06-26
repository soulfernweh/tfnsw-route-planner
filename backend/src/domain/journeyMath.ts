// Pure helper functions for deriving journey-level values from a journey's legs.
//
// These helpers are used by the EFA normaliser (task 5) when building `Journey`
// objects and are intentionally pure (no I/O, no mutation of inputs) so they can
// be exhaustively property-tested. See:
//   .kiro/specs/tfnsw-route-planner/design.md ("Model Notes", "Correctness
//   Properties" 5 and 8).
//
// Requirements covered: 2.3, 3.3, 4.2, 4.4.

import type { Fare, Leg } from './models.js';

/**
 * Determine whether a leg is "fare-bearing" — i.e. a leg that the TfNSW API
 * would normally price.
 *
 * Walk and transfer connector legs legitimately carry no Opal fare, so they are
 * NOT fare-bearing and their absent fare must not force the whole journey's
 * total fare to `null`. Every other leg (an actual vehicle ride) is expected to
 * carry a fare.
 *
 * @param leg - the leg to classify
 * @returns true when the leg is expected to carry a fare
 */
export function isFareBearingLeg(leg: Leg): boolean {
  return !leg.isTransfer && leg.mode !== 'walk';
}

/**
 * Aggregate per-leg fares into a single journey `totalFare`.
 *
 * Rule (per design "Fare aggregation" note and Req 4.4):
 *  - If any fare-BEARING leg lacks fare data (`fare === null`), the journey's
 *    total fare is `null` (and the journey is later excluded from economical
 *    ranking).
 *  - Non-fare-bearing connector legs (walk / transfer) with `fare === null` do
 *    NOT force a `null` total; they simply contribute nothing.
 *  - Otherwise the total is the sum of every present leg fare's `amountCents`,
 *    in AUD.
 *
 * A journey with no fare-bearing legs at all (e.g. a walk-only journey) has no
 * priced rides and therefore yields `null` rather than a misleading 0.00 fare.
 *
 * @param legs - the journey's ordered legs
 * @returns the aggregated fare, or `null` when the journey is not fully priced
 */
export function sumLegFares(legs: Leg[]): Fare | null {
  const fareBearingLegs = legs.filter(isFareBearingLeg);

  // No priced rides => no meaningful total fare.
  if (fareBearingLegs.length === 0) {
    return null;
  }

  // Any priced ride missing its fare makes the total unknowable.
  if (fareBearingLegs.some((leg) => leg.fare === null)) {
    return null;
  }

  // Sum the fares of every leg that carries one (fare-bearing by definition,
  // but a connector with an unexpected fare is still counted defensively).
  let amountCents = 0;
  for (const leg of legs) {
    if (leg.fare !== null) {
      amountCents += leg.fare.amountCents;
    }
  }

  return { amountCents, currency: 'AUD' };
}

/**
 * Compute the total travel time of a journey, in whole minutes.
 *
 * Defined as the difference between the LAST leg's scheduled arrival and the
 * FIRST leg's scheduled departure. Because it spans the whole journey, it
 * inherently includes any waiting time between legs (transfer waits), per
 * Req 2.3 / 3.3.
 *
 * @param legs - the journey's ordered legs (length >= 1)
 * @returns whole minutes between first departure and last arrival
 * @throws {Error} if `legs` is empty (a journey always has at least one leg)
 */
export function computeTravelTimeMinutes(legs: Leg[]): number {
  if (legs.length === 0) {
    throw new Error('computeTravelTimeMinutes: a journey must have at least one leg');
  }

  const firstDeparture = Date.parse(legs[0]!.departureTime);
  const lastArrival = Date.parse(legs[legs.length - 1]!.arrivalTime);

  if (Number.isNaN(firstDeparture) || Number.isNaN(lastArrival)) {
    throw new Error('computeTravelTimeMinutes: leg times must be valid ISO 8601 timestamps');
  }

  const diffMs = lastArrival - firstDeparture;
  return Math.round(diffMs / 60000);
}

/**
 * Derive the user-facing transfer count for a journey.
 *
 * A transfer is a change between vehicles. The design defines this as the count
 * of non-walk vehicle legs minus one, floored at zero (a single vehicle leg, or
 * a walk-only journey, has zero transfers).
 *
 * @param legs - the journey's ordered legs
 * @returns the number of vehicle changes (>= 0)
 */
export function computeTransferCount(legs: Leg[]): number {
  const vehicleLegCount = legs.filter(isFareBearingLeg).length;
  return Math.max(0, vehicleLegCount - 1);
}
