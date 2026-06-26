// Public entry point for the @tfnsw/backend package.
// Services, the TfNSW client, and the REST layer are added in later tasks
// (see .kiro/specs/tfnsw-route-planner/tasks.md).

// Domain models (normalised, client-facing types) and service interfaces.
export type {
  Location,
  LocationType,
  TransportMode,
  Leg,
  LegStop,
  Fare,
  Journey,
  RouteRequest,
  RouteResult,
  RouteComparison,
  ComparisonEntry,
  LocationService,
  RouteRankingEngine,
} from './domain/models.js';

// Typed error classes and the safe client-facing error envelope helpers.
export {
  AppError,
  ValidationError,
  ServiceUnavailableError,
  NotFoundError,
  ErrorCode,
  toErrorEnvelope,
  toHttpStatus,
} from './domain/errors.js';

export type { ErrorEnvelope } from './domain/errors.js';

// Pure journey math helpers (fare aggregation, travel-time, transfer count).
export {
  isFareBearingLeg,
  sumLegFares,
  computeTravelTimeMinutes,
  computeTransferCount,
} from './domain/journeyMath.js';

// Pure route ranking & comparison engine (fastest/economical selection,
// fastest-vs-economical comparison builder).
export {
  selectFastest,
  selectEconomical,
  buildComparison,
} from './domain/rankingEngine.js';

// Secure, resilient TfNSW Trip Planner client (the only network-facing
// component; reads the API key from the backend environment only).
export { TfnswClient, sydneyDateTimeParts } from './tfnsw/client.js';
export type {
  FetchFn,
  DepArrMode,
  TfnswClientOptions,
} from './tfnsw/client.js';

// In-memory TTL + LRU cache primitive and its key-building / TTL helpers
// (caching strategy infrastructure; not yet wired into the TfNSW client).
export {
  TtlLruCache,
  STOP_FINDER_TTL_MS,
  TRIP_TTL_MS,
  TRIP_TIME_BUCKET_MS,
  buildCacheKey,
  normaliseQuery,
  stopFinderCacheKey,
  tripTimeBucket,
  tripCacheKey,
} from './infra/cache.js';

export type { TtlLruCacheOptions } from './infra/cache.js';

// Location autocomplete service (short-query guard, caching, 10-result cap).
export { DefaultLocationService, MIN_QUERY_LENGTH } from './services/locationService.js';
export type { StopFinderClient } from './services/locationService.js';

// Route discovery, ranking, and comparison service (orchestrates the TfNSW
// client + cache + pure ranking engine).
export { RouteService } from './services/routeService.js';
export type {
  RoutePlanningClient,
  RouteServiceOptions,
} from './services/routeService.js';

// API middleware: HTTP-agnostic input validation/allowlisting, an in-memory
// per-IP + global rate limiter, and CORS header derivation (mounted by the
// REST layer in task 9.2).
export {
  QUERY_MIN_LENGTH,
  QUERY_MAX_LENGTH,
  LOCATION_ID_PATTERN,
  validateLocationQuery,
  validateRouteParams,
  createRateLimiter,
  parseAllowedOrigins,
  corsHeaders,
} from './api/middleware.js';

export type {
  QueryParams,
  ValidatedLocationQuery,
  RateLimiterOptions,
  RateLimitResult,
  RateLimiter,
} from './api/middleware.js';

// REST controllers: the framework-agnostic routing core, the Node `http`
// adapter, and the Cache-Control max-age constants (mounted by `server.ts`).
export {
  handleApiRequest,
  createNodeRequestListener,
  LOCATIONS_MAX_AGE_SECONDS,
  ROUTES_MAX_AGE_SECONDS,
} from './api/routes.js';

export type {
  ApiRequestContext,
  ApiResponse,
  RouteHandlerDeps,
} from './api/routes.js';

// Composition root + HTTP server bootstrap (config loading, dependency graph,
// server construction/start).
export {
  loadConfig,
  buildDependencies,
  buildServer,
  startServer,
} from './server.js';

export type { ServerConfig } from './server.js';
