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
//   3. CACHES trip results — keyed by `(originId, destinationId, time-bucket)`
//      with the short trip TTL (see the design's "Caching Strategy"); a cache
//      hit skips the client entirely.
//   4. FETCHES + NORMALISES journeys — on a miss it calls the injected
//      `TfnswClient.trip`, which returns already-normalised `Journey[]` (capped
//      at 5, ordered by departure). Client failures surface as
//      `ServiceUnavailableError` (Req 2.6) and are propagated unchanged.
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
// Requirements: 2.1, 2.4, 2.5, 3.1, 4.1, 5.1, 5.3, 5.4, 5.6.

import type {
  Journey,
  RouteRequest,
  RouteResult,
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
  tripCacheKey,
  tripTimeBucket,
} from '../infra/cache.js';

/**
 * The minimal slice of the TfNSW client that `RouteService` depends on: a
 * single `trip` lookup returning normalised journeys. Depending on this narrow
 * interface (rather than the concrete `TfnswClient`) keeps the service easy to
 * unit-test with a lightweight fake.
 */
export interface RoutePlanningClient {
  trip(
    originId: string,
    destinationId: string,
    time: Date,
    mode: 'dep' | 'arr',
  ): Promise<Journey[]>;
}

/** Construction-time dependencies for {@link RouteService}. */
export interface RouteServiceOptions {
  /**
   * Optional trip cache. When provided, normalised journeys are cached keyed by
   * `(originId, destinationId, time-bucket)` with the {@link TRIP_TTL_MS} TTL,
   * and a cache hit skips the upstream client. When omitted, every call goes to
   * the client.
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
   *  - Serves journeys from the trip cache on a hit; otherwise calls the client
   *    and caches the normalised result.
   *  - Ranks the journeys (fastest / economical) and builds the side-by-side
   *    comparison. An empty journey list yields a result with no journeys, null
   *    ids, and an empty comparison (Req 2.4).
   *  - Propagates `ServiceUnavailableError` from the client on upstream failure
   *    (Req 2.6).
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
    const journeys = await this.resolveJourneys(
      request.originId,
      request.destinationId,
      date,
    );

    return buildRouteResult(journeys);
  }

  /**
   * Return the normalised journeys for the trip, consulting the cache first and
   * falling back to the client on a miss. The client result is cached for
   * subsequent requests sharing the same time-bucket. Client failures (e.g.
   * `ServiceUnavailableError`) propagate unchanged.
   */
  private async resolveJourneys(
    originId: string,
    destinationId: string,
    date: Date,
  ): Promise<Journey[]> {
    const cacheKey =
      this.cache === undefined
        ? undefined
        : tripCacheKey(originId, destinationId, tripTimeBucket(date));

    if (this.cache !== undefined && cacheKey !== undefined) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const journeys = await this.client.trip(
      originId,
      destinationId,
      date,
      'dep',
    );

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
