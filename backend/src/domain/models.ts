// Normalised, client-facing domain models for the TfNSW Route Planner.
//
// These models are the clean representations produced by the EFA normaliser and
// are independent of the raw EFA (Elektronische Fahrplanauskunft) JSON shape.
// They are shared by the backend services, ranking engine, and REST layer, and
// describe the contract consumed by the web frontend and the future Android app.
//
// See: .kiro/specs/tfnsw-route-planner/design.md ("Data Models",
// "Backend Interfaces").

// ---------------------------------------------------------------------------
// Core value types
// ---------------------------------------------------------------------------

/**
 * The kind of transport location returned by the TfNSW stop finder.
 */
export type LocationType =
  | 'stop'
  | 'station'
  | 'platform'
  | 'poi'
  | 'address'
  | 'suburb';

/**
 * The transport mode used for a journey leg.
 */
export type TransportMode =
  | 'train'
  | 'metro'
  | 'bus'
  | 'ferry'
  | 'lightRail'
  | 'coach'
  | 'walk'
  | 'bicycle'
  | 'school'
  | 'other';

/**
 * A transport stop, station, platform, or point of interest that can serve as
 * a trip origin or destination.
 */
export interface Location {
  /** TfNSW stable location id (used as origin/destination). */
  id: string;
  /** Display name. */
  name: string;
  /** Location category. */
  type: LocationType;
  /** Parent locality, where provided. */
  suburb: string | null;
  /**
   * Served public-transport modes, mapped from the stop_finder `modes` integer
   * codes. Empty when the location serves no transit (e.g. address/POI/suburb).
   * Drives the result priority tier (Req 1.3) and is surfaced for display.
   */
  modes: TransportMode[];
  /**
   * EFA `matchQuality` (higher = better); orders results within a priority tier
   * (Req 1.4). Defaults to 0 when absent.
   */
  matchQuality: number;
  /** Geographic coordinate (latitude/longitude), where provided. */
  coord: {
    lat: number;
    lng: number;
  } | null;
}

/**
 * Monetary fare value. Amounts are integer cents to avoid float rounding
 * errors. Display formatting (AUD to two decimals) happens at the presentation
 * boundary.
 */
export interface Fare {
  /** Default adult Opal fare, in integer cents (>= 0). */
  amountCents: number;
  currency: 'AUD';
}

/**
 * An endpoint (origin or destination) of a single journey leg.
 */
export interface LegStop {
  locationName: string;
  /** Platform identifier, where provided by TfNSW. */
  platform: string | null;
  /** ISO 8601 scheduled time. */
  time: string;
}

/**
 * A single leg of a journey (one vehicle ride or a walk/transfer connector).
 */
export interface Leg {
  origin: LegStop;
  destination: LegStop;
  mode: TransportMode;
  /** e.g. "T1 North Shore Line", "389". Null where unavailable. */
  routeName: string | null;
  /** ISO 8601 scheduled departure time. */
  departureTime: string;
  /** ISO 8601 scheduled arrival time. */
  arrivalTime: string;
  /** Arrival minus departure for this leg, in minutes. */
  durationMinutes: number;
  /** EFA leg.distance in metres, used for fare estimation. Null where unavailable. */
  distanceMetres: number | null;
  /** True for walk/transfer connector legs. */
  isTransfer: boolean;
  /** Per-leg adult Opal fare where available. */
  fare: Fare | null;
}

/**
 * A complete journey option from origin to destination.
 */
export interface Journey {
  /**
   * Backend-assigned SYNTHETIC id (a hash/index of the journey) used purely for
   * client-side selection. NOT supplied by TfNSW — the trip API has no journey id.
   */
  id: string;
  /** Ordered legs, length >= 1. */
  legs: Leg[];
  /** ISO 8601, equals the first leg's departure. */
  departureTime: string;
  /** ISO 8601, equals the last leg's arrival. */
  arrivalTime: string;
  /** Arrival minus departure (includes transfer waits), in minutes. */
  travelTimeMinutes: number;
  /** Number of vehicle changes. */
  transferCount: number;
  /** Distinct transport modes used, in order. */
  modes: TransportMode[];
  /** Sum of leg fares; null if any required fare is missing. */
  totalFare: Fare | null;
}

// ---------------------------------------------------------------------------
// Request / result models
// ---------------------------------------------------------------------------

/**
 * Request to plan routes between an origin and a destination.
 */
export interface RouteRequest {
  originId: string;
  destinationId: string;
  /** ISO 8601 Selected_Time, interpreted per `depArr`. */
  time: string;
  /**
   * 'dep' = depart at/after `time` (Leave now / Leave at); 'arr' = arrive
   * at/before `time` (Arrive by). "Leave now" is modelled as 'dep' with
   * `time` set to the current time.
   */
  depArr: 'dep' | 'arr';
  /**
   * Transit modes to include in results. An empty list OR a list containing all
   * selectable modes means "no exclusion" (include everything). Any strict,
   * non-empty subset causes the complement to be excluded upstream.
   * walk/bicycle are connectors and are never part of this set.
   */
  includedModes: TransportMode[];
}

/**
 * The selectable public-transport modes a user can include/exclude
 * (Requirement 6). Order matches the Mode_Selection control. walk/bicycle/other
 * are NOT selectable.
 */
export type SelectableMode =
  | 'train'
  | 'metro'
  | 'lightRail'
  | 'bus'
  | 'coach'
  | 'ferry'
  | 'school';

/**
 * A single side of the fastest-vs-economical comparison.
 */
export interface ComparisonEntry {
  journeyId: string;
  travelTimeMinutes: number;
  totalFare: Fare | null;
  transferCount: number;
  modes: TransportMode[];
}

/**
 * Side-by-side comparison of the fastest vs economical routes (Requirement 5).
 */
export interface RouteComparison {
  fastest: ComparisonEntry | null;
  economical: ComparisonEntry | null;
  /** True when the fastest and economical routes are the same journey. */
  sameRoute: boolean;
  /** Absolute difference of travel times; null when not computable. */
  travelTimeDifferenceMinutes: number | null;
  /** Absolute difference of fares; null when either fare is missing. */
  fareDifferenceCents: number | null;
  fasterRouteId: string | null;
  cheaperRouteId: string | null;
  /** Req 5.6: true when the fastest route has no fare data. */
  fareUnavailableForFastest: boolean;
}

/**
 * Result of route discovery + ranking.
 */
export interface RouteResult {
  /** Up to 5 journeys, ordered by departureTime. */
  journeys: Journey[];
  fastestId: string | null;
  economicalId: string | null;
  comparison: RouteComparison;
}

// ---------------------------------------------------------------------------
// Backend service interfaces
// ---------------------------------------------------------------------------

/**
 * Location autocomplete service (Requirement 1).
 */
export interface LocationService {
  /**
   * Returns up to 10 normalised locations. Throws ServiceUnavailableError on
   * upstream failure.
   */
  searchLocations(query: string): Promise<Location[]>;
}

/**
 * Route discovery, ranking, and comparison service (Requirements 2-5).
 */
export interface RouteService {
  /**
   * Validates inputs, fetches and normalises up to 5 journeys ordered by
   * departure time, then computes ranking + comparison.
   */
  planRoutes(request: RouteRequest): Promise<RouteResult>;
}

/**
 * Pure ranking & comparison engine over normalised journeys.
 */
export interface RouteRankingEngine {
  selectFastest(journeys: Journey[]): Journey | null;
  selectEconomical(journeys: Journey[]): Journey | null;
  buildComparison(
    fastest: Journey | null,
    economical: Journey | null,
  ): RouteComparison;
}

/**
 * TfNSW API client + normaliser. The only component aware of the raw EFA JSON
 * shape.
 */
export interface TfnswClient {
  stopFinder(query: string): Promise<Location[]>;
  trip(params: {
    originId: string;
    destinationId: string;
    time: Date;
    depArr: 'dep' | 'arr';
    calcNumberOfTrips?: number;
    excludedModes?: SelectableMode[];
  }): Promise<Journey[]>;
}
