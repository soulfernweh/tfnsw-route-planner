// Route discovery, ranking, and comparison service (Requirements 2-5).
//
// `RouteService.planRoutes` is the orchestration seam between the REST layer
// and the pure domain logic. It:
//
//   1. VALIDATES inputs — an identical origin and destination is rejected with
//      a `ValidationError` BEFORE any upstream call is made (Req 2.5).
//   2. RESOLVES the request time — the ISO 8601 `request.time` is parsed to a
//      `Date`, defaulting to "now" when absent or unparseable, so the upstream
//      trip request and the cache time-bucket always have a concrete instant.
//   3. CACHES the merged window — keyed by `(originId, destinationId, depArr,
//      included-modes signature, time-bucket)` with the short trip TTL (see the
//      design's "Caching Strategy"); a cache hit skips both client calls.
//   4. FETCHES + NORMALISES journeys — on a miss it issues TWO concurrent
//      `TfnswClient.trip` queries around the Selected_Time (a forward query and
//      an opposite-direction query) to build an earlier+later window, then
//      MERGES, DE-DUPLICATES (by a stable signature), and ORDERS the journeys by
//      non-decreasing departure time (see "Earlier + Later Window" in the
//      design). The same `excludedModes` (the complement of the request's
//      `includedModes`) is applied to BOTH queries. Client failures surface as
//      `ServiceUnavailableError` (Req 2.6) and are propagated unchanged — if
//      EITHER query fails, the whole search fails.
//   5. RANKS + COMPARES — delegates to the pure ranking engine
//      (`selectFastest`, `selectEconomical`, `buildComparison`) to populate
//      `fastestId`, `economicalId`, and the `comparison` into a `RouteResult`.
//
// Design reference: .kiro/specs/tfnsw-route-planner/design.md
//   ("Components and Interfaces" → RouteService, "Request Flows" → Route
//    discovery + ranking, "Caching Strategy", "Error Handling").
//
// DEPENDENCY INJECTION: the constructor takes the TfNSW client (or any minimal
// object exposing `trip`) and an optional trip cache, so the service is fully
// unit-testable with a fake client (e.g. to assert the origin == destination
// rejection never touches the client).
//
// Requirements: 2.1, 2.2, 2.4, 2.5, 3.1, 4.1, 5.1, 5.3, 5.4, 5.6, 7.3, 7.4, 7.5.

import type {
  Journey,
  RouteRequest,
  RouteResult,
  SelectableMode,
  TransportMode,
  RouteService as IRouteService,
} from '../domain/models.js';
import { ValidationError } from '../domain/errors.js';
import {
  buildComparison,
  selectEconomical,
  selectFastest,
} from '../domain/rankingEngine.js';
import {
  TtlLruCache,
  TRIP_TTL_MS,
  tripTimeBucket,
  tripWindowCacheKey,
} from '../infra/cache.js';

/**
 * The minimal slice of the TfNSW client that `RouteService` depends on: a
 * single `trip` lookup returning normalised journeys. Depending on this narrow
 * interface (rather than the concrete `TfnswClient`) keeps the service easy to
 * unit-test with a lightweight fake.
 */
export interface RoutePlanningClient {
  trip(params: {
    originId: string;
    destinationId: string;
    time: Date;
    depArr: 'dep' | 'arr';
    calcNumberOfTrips?: number;
    excludedModes?: SelectableMode[];
  }): Promise<Journey[]>;
}

/** Construction-time dependencies for {@link RouteService}. */
export interface RouteServiceOptions {
  /**
   * Optional trip cache. When provided, the merged earlier+later journey window
   * is cached keyed by `(originId, destinationId, depArr, included-modes
   * signature, time-bucket)` with the {@link TRIP_TTL_MS} TTL, and a cache hit
   * skips both upstream client calls. When omitted, every call goes to the
   * client.
   */
  cache?: TtlLruCache<Journey[]>;
}

/**
 * Concrete {@link IRouteService} implementation. Stateless apart from the
 * optional injected cache, so it is safe to share a single instance across
 * requests.
 */
export class RouteService implements IRouteService {
  private readonly client: RoutePlanningClient;
  private readonly cache: TtlLruCache<Journey[]> | undefined;

  /**
   * @param client - the TfNSW client (or any object exposing `trip`)
   * @param options - optional dependencies (e.g. the trip cache)
   */
  public constructor(client: RoutePlanningClient, options: RouteServiceOptions = {}) {
    this.client = client;
    this.cache = options.cache;
  }

  /**
   * Plan, rank, and compare routes between the requested origin and
   * destination.
   *
   * Behaviour:
   *  - Rejects an identical origin/destination with `ValidationError` WITHOUT
   *    calling the client (Req 2.5).
   *  - Resolves `request.time` to a concrete instant (now if absent/invalid).
   *  - Serves the merged journey window from the trip cache on a hit; otherwise
   *    issues two trip queries (forward + opposite direction), merges,
   *    de-duplicates, and orders them, then caches the window.
   *  - Ranks the journeys (fastest / economical) and builds the side-by-side
   *    comparison. An empty journey list yields a result with no journeys, null
   *    ids, and an empty comparison (Req 2.4).
   *  - Propagates `ServiceUnavailableError` from either client call on upstream
   *    failure (Req 2.6).
   */
  public async planRoutes(request: RouteRequest): Promise<RouteResult> {
    // Req 2.5: identical origin and destination is invalid. Reject up-front so
    // the upstream client is never invoked for a request that cannot produce a
    // meaningful route.
    if (request.originId === request.destinationId) {
      throw new ValidationError(
        'Origin and destination must be different locations.',
      );
    }

    const date = parseRequestTime(request.time);
    const journeys = await this.resolveJourneys(request, date);

    return buildRouteResult(journeys);
  }

  /**
   * Return the merged earlier+later journey window for the trip (see the
   * design's "Earlier + Later Window"), consulting the cache first and falling
   * back to the two-query strategy on a miss.
   *
   * Two `trip` queries are issued CONCURRENTLY around the Selected_Time:
   *  - for `depArr='dep'`: a forward query (`dep`) plus an earlier-trips query
   *    (`arr`), and
   *  - for `depArr='arr'`: a primary query (`arr`) plus a later-alternatives
   *    query (`dep`).
   *
   * The same `excludedModes` (the complement of `request.includedModes`) is
   * applied to both queries. Their journey lists are merged, de-duplicated by a
   * stable signature, and ordered by non-decreasing departure time. If EITHER
   * query rejects (e.g. `ServiceUnavailableError`), the rejection propagates and
   * the whole search fails (Req 2.6).
   */
  private async resolveJourneys(
    request: RouteRequest,
    date: Date,
  ): Promise<Journey[]> {
    const { originId, destinationId, depArr } = request;
    const excludedModes = computeExcludedModes(request.includedModes);
    const signature = includedModesSignature(request.includedModes);

    const cacheKey =
      this.cache === undefined
        ? undefined
        : tripWindowCacheKey(
            originId,
            destinationId,
            depArr,
            signature,
            tripTimeBucket(date),
          );

    if (this.cache !== undefined && cacheKey !== undefined) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    // The opposite direction supplies the other half of the window: an
    // arrive-by query yields trips departing BEFORE `date` (earlier trips) for a
    // depart-at search, and a depart-at query yields LATER trips for an
    // arrive-by search.
    const oppositeDepArr: 'dep' | 'arr' = depArr === 'dep' ? 'arr' : 'dep';

    // Both queries run concurrently; Promise.all rejects (propagating the
    // ServiceUnavailableError) as soon as either query fails.
    const [primary, opposite] = await Promise.all([
      this.client.trip({
        originId,
        destinationId,
        time: date,
        depArr,
        calcNumberOfTrips: WINDOW_CALC_NUMBER_OF_TRIPS,
        excludedModes,
      }),
      this.client.trip({
        originId,
        destinationId,
        time: date,
        depArr: oppositeDepArr,
        calcNumberOfTrips: WINDOW_CALC_NUMBER_OF_TRIPS,
        excludedModes,
      }),
    ]);

    const journeys = mergeWindow(primary, opposite);

    if (this.cache !== undefined && cacheKey !== undefined) {
      this.cache.set(cacheKey, journeys, TRIP_TTL_MS);
    }

    return journeys;
  }
}

/**
 * Parse an ISO 8601 time string into a `Date`, defaulting to the current time
 * when the value is absent, empty, or unparseable. This keeps `planRoutes`
 * total: a malformed time degrades to "depart now" rather than failing.
 */
function parseRequestTime(time: string | undefined | null): Date {
  if (typeof time !== 'string' || time.trim() === '') {
    return new Date();
  }
  const parsed = new Date(time);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Assemble the `RouteResult` from a (possibly empty) normalised journey list by
 * running the pure ranking engine. For an empty list this yields no journeys,
 * null ids, and `buildComparison(null, null)`.
 */
function buildRouteResult(journeys: Journey[]): RouteResult {
  const fastest = selectFastest(journeys);
  const economical = selectEconomical(journeys);
  const comparison = buildComparison(fastest, economical);

  return {
    journeys,
    fastestId: fastest?.id ?? null,
    economicalId: economical?.id ?? null,
    comparison,
  };
}

// ---------------------------------------------------------------------------
// Earlier + Later Window helpers (Req 2.2, 7.3-7.5)
// ---------------------------------------------------------------------------

/**
 * `calcNumberOfTrips` issued for EACH of the two window queries (≈6 per the
 * design). The forward query yields trips at/after the Selected_Time and the
 * opposite-direction query supplies at least this many earlier/later trips, so
 * the merged window comfortably includes the "at least 5 earlier trips" the
 * design guarantees when the API offers them.
 */
const WINDOW_CALC_NUMBER_OF_TRIPS = 6;

/**
 * The seven user-selectable public-transport modes, in Mode_Selection order.
 * walk / bicycle / other are connectors and are never selectable.
 */
const SELECTABLE_MODES: readonly SelectableMode[] = [
  'train',
  'metro',
  'lightRail',
  'bus',
  'coach',
  'ferry',
  'school',
];

/**
 * Compute the `excludedModes` to pass to the client: the seven selectable modes
 * MINUS the included ones.
 *
 * Per the design's mode-inclusion semantics, an EMPTY `includedModes` (or one
 * that covers ALL seven selectable modes) means "no exclusion" — every mode is
 * included — so this returns an empty array in those cases. A strict, non-empty
 * subset returns its complement. Non-selectable modes (walk/bicycle/other) in
 * `includedModes` are ignored.
 */
function computeExcludedModes(
  includedModes: TransportMode[],
): SelectableMode[] {
  const includedSelectable = SELECTABLE_MODES.filter((mode) =>
    includedModes.includes(mode),
  );

  // Empty (or no selectable modes) and full coverage both mean "no exclusion".
  if (
    includedSelectable.length === 0 ||
    includedSelectable.length === SELECTABLE_MODES.length
  ) {
    return [];
  }

  return SELECTABLE_MODES.filter((mode) => !includedModes.includes(mode));
}

/**
 * Canonical signature of the included selectable modes for cache keying. When
 * no exclusion applies (empty or all-modes), returns `'all'`; otherwise returns
 * the sorted, comma-joined included selectable modes so the signature is stable
 * regardless of input order.
 */
function includedModesSignature(includedModes: TransportMode[]): string {
  const includedSelectable = SELECTABLE_MODES.filter((mode) =>
    includedModes.includes(mode),
  );

  if (
    includedSelectable.length === 0 ||
    includedSelectable.length === SELECTABLE_MODES.length
  ) {
    return 'all';
  }

  return [...includedSelectable].sort().join(',');
}

/**
 * The stable de-duplication signature for a journey (the trip API supplies no
 * journey id): `(first leg origin name, last leg destination name,
 * departureTime, arrivalTime)`. Journeys appearing in both query results share
 * this signature and are collapsed to a single entry.
 */
function journeySignature(journey: Journey): string {
  const firstLeg = journey.legs[0];
  const lastLeg = journey.legs[journey.legs.length - 1];
  const originName = firstLeg?.origin.locationName ?? '';
  const destinationName = lastLeg?.destination.locationName ?? '';
  return [
    originName,
    destinationName,
    journey.departureTime,
    journey.arrivalTime,
  ].join('\u241F');
}

/**
 * Parse an ISO 8601 timestamp to epoch ms for ordering. Falls back to `+∞` for
 * unparseable values so they sort last rather than corrupting the order.
 */
function departureEpoch(journey: Journey): number {
  const ms = Date.parse(journey.departureTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Merge the two window query results into a single journey list: concatenate,
 * de-duplicate by {@link journeySignature} (keeping the first occurrence), and
 * order by non-decreasing departure time. The full merged set is returned
 * (no trimming), so all earlier trips the opposite-direction query offered are
 * retained.
 */
function mergeWindow(primary: Journey[], opposite: Journey[]): Journey[] {
  const bySignature = new Map<string, Journey>();
  for (const journey of [...primary, ...opposite]) {
    const signature = journeySignature(journey);
    if (!bySignature.has(signature)) {
      bySignature.set(signature, journey);
    }
  }

  return [...bySignature.values()].sort(
    (a, b) => departureEpoch(a) - departureEpoch(b),
  );
}
