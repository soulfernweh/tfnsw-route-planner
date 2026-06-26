// Pure ranking functions over normalised journeys.
//
// This module implements the `RouteRankingEngine` interface (see `models.ts`):
// the journey-selection functions (`selectFastest`, `selectEconomical`) and the
// comparison builder (`buildComparison`). Every function here is pure (no I/O,
// no mutation of inputs) and deterministic for ties, so it can be exhaustively
// property-tested. See:
//   .kiro/specs/tfnsw-route-planner/design.md ("Route Selection Rules",
//   "Correctness Properties" 7, 9, 10, 12, 13).
//
// Requirements covered: 3.1, 4.1, 4.4, 5.3, 5.4, 5.6.

import type {
  ComparisonEntry,
  Journey,
  RouteComparison,
} from './models.js';

/**
 * Select the fastest journey from a list.
 *
 * Ranking rule (Req 3.1):
 *  - Primary: minimum `travelTimeMinutes`.
 *  - Tiebreak: among journeys sharing that minimum travel time, the one with
 *    the fewest `transferCount`.
 *
 * The comparison is strict (`<`) so the first journey encountered at the best
 * (travelTime, transferCount) ranking is retained. This makes ties resolve to
 * the earliest such journey in the input order, giving a stable, deterministic
 * result.
 *
 * @param journeys - candidate journeys (may be empty)
 * @returns the fastest journey, or `null` when the list is empty
 */
export function selectFastest(journeys: Journey[]): Journey | null {
  if (journeys.length === 0) {
    return null;
  }

  let best = journeys[0]!;
  for (let i = 1; i < journeys.length; i++) {
    const candidate = journeys[i]!;
    if (candidate.travelTimeMinutes < best.travelTimeMinutes) {
      best = candidate;
    } else if (
      candidate.travelTimeMinutes === best.travelTimeMinutes &&
      candidate.transferCount < best.transferCount
    ) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Select the most economical (cheapest) journey from a list.
 *
 * Ranking rule (Req 4.1, 4.4):
 *  - Only journeys with a non-null `totalFare` are eligible; journeys whose
 *    fare could not be determined are EXCLUDED entirely.
 *  - Primary: minimum `totalFare.amountCents`.
 *  - Tiebreak: among priced journeys sharing that minimum fare, the one with
 *    the shortest `travelTimeMinutes`.
 *
 * The comparison is strict (`<`) so the first priced journey encountered at the
 * best (fare, travelTime) ranking is retained, giving a stable, deterministic
 * result for ties.
 *
 * @param journeys - candidate journeys (may be empty or fully unpriced)
 * @returns the cheapest priced journey, or `null` when none are priced
 */
export function selectEconomical(journeys: Journey[]): Journey | null {
  let best: Journey | null = null;
  for (const candidate of journeys) {
    if (candidate.totalFare === null) {
      continue;
    }
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.totalFare.amountCents < best.totalFare!.amountCents) {
      best = candidate;
    } else if (
      candidate.totalFare.amountCents === best.totalFare!.amountCents &&
      candidate.travelTimeMinutes < best.travelTimeMinutes
    ) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Project a journey into the compact `ComparisonEntry` shown in the
 * side-by-side comparison view. The `modes` array is copied so the entry never
 * shares a mutable reference with the source journey (keeping this pure).
 */
function toComparisonEntry(journey: Journey): ComparisonEntry {
  return {
    journeyId: journey.id,
    travelTimeMinutes: journey.travelTimeMinutes,
    totalFare: journey.totalFare,
    transferCount: journey.transferCount,
    modes: [...journey.modes],
  };
}

/**
 * Build the side-by-side fastest-vs-economical comparison (Requirement 5).
 *
 * This is a pure function over the two already-selected journeys (typically the
 * outputs of {@link selectFastest} and {@link selectEconomical}); it performs
 * no ranking itself, only the comparison math and labelling.
 *
 * Behaviour (Req 5.3, 5.4, 5.6):
 *  - `fastest` / `economical` are projected to `ComparisonEntry` (or `null`
 *    when the corresponding journey is absent).
 *  - `sameRoute` is true when both journeys are present and share the same
 *    `id` — the fastest route is also the most economical. In that case the
 *    travel-time difference is naturally 0 and, if priced, the fare difference
 *    is 0, with both labels pointing at the single route.
 *  - `travelTimeDifferenceMinutes` is the absolute difference of the two travel
 *    times, or `null` when either journey is missing.
 *  - `fareDifferenceCents` is the absolute difference of the two total fares, or
 *    `null` when either side is absent or its fare is unavailable.
 *  - `fasterRouteId` is the id of the journey with the lower `travelTimeMinutes`
 *    (ties resolve to the fastest journey); `cheaperRouteId` is the id of the
 *    journey with the lower total fare, only when BOTH journeys are priced
 *    (ties resolve to the economical journey).
 *  - `fareUnavailableForFastest` is true when the fastest journey exists but has
 *    no `totalFare`; the comparison then still reports travel time and
 *    transfers, with `fareDifferenceCents` left `null` (Req 5.6).
 *
 * @param fastest - the fastest journey, or `null` when there are no journeys
 * @param economical - the most economical (priced) journey, or `null` when none
 *                      is priceable
 * @returns the fully populated {@link RouteComparison}
 */
export function buildComparison(
  fastest: Journey | null,
  economical: Journey | null,
): RouteComparison {
  const fastestEntry = fastest === null ? null : toComparisonEntry(fastest);
  const economicalEntry =
    economical === null ? null : toComparisonEntry(economical);

  const sameRoute =
    fastest !== null && economical !== null && fastest.id === economical.id;

  const fareUnavailableForFastest =
    fastest !== null && fastest.totalFare === null;

  let travelTimeDifferenceMinutes: number | null = null;
  let fasterRouteId: string | null = null;
  if (fastest !== null && economical !== null) {
    travelTimeDifferenceMinutes = Math.abs(
      fastest.travelTimeMinutes - economical.travelTimeMinutes,
    );
    // Ties resolve to the fastest journey (`<=`), which selectFastest has
    // already ranked ahead on the transfer tiebreak.
    fasterRouteId =
      fastest.travelTimeMinutes <= economical.travelTimeMinutes
        ? fastest.id
        : economical.id;
  } else if (fastest !== null) {
    fasterRouteId = fastest.id;
  } else if (economical !== null) {
    fasterRouteId = economical.id;
  }

  let fareDifferenceCents: number | null = null;
  let cheaperRouteId: string | null = null;
  if (
    fastest !== null &&
    economical !== null &&
    fastest.totalFare !== null &&
    economical.totalFare !== null
  ) {
    fareDifferenceCents = Math.abs(
      fastest.totalFare.amountCents - economical.totalFare.amountCents,
    );
    // Ties resolve to the economical journey, which selectEconomical has
    // already ranked ahead on the travel-time tiebreak.
    cheaperRouteId =
      economical.totalFare.amountCents <= fastest.totalFare.amountCents
        ? economical.id
        : fastest.id;
  }

  return {
    fastest: fastestEntry,
    economical: economicalEntry,
    sameRoute,
    travelTimeDifferenceMinutes,
    fareDifferenceCents,
    fasterRouteId,
    cheaperRouteId,
    fareUnavailableForFastest,
  };
}
