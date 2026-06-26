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
  RouteService,
  RouteRankingEngine,
  TfnswClient,
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
