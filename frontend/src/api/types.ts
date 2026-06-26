// Client-side TypeScript types mirroring the backend API contract.
//
// This is a local copy of the design's normalised, client-facing response
// shapes (see .kiro/specs/tfnsw-route-planner/design.md, "Data Models").
// The frontend depends only on this contract, never on the backend
// implementation. Keeping a local copy avoids coupling the SPA build to the
// backend's internal domain module.

/** The kind of transport location returned by the TfNSW stop finder. */
export type LocationType =
  | 'stop'
  | 'station'
  | 'platform'
  | 'poi'
  | 'address'
  | 'suburb';

/** The transport mode used for a journey leg. */
export type TransportMode =
  | 'train'
  | 'metro'
  | 'bus'
  | 'ferry'
  | 'lightRail'
  | 'coach'
  | 'walk'
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

/** An endpoint (origin or destination) of a single journey leg. */
export interface LegStop {
  locationName: string;
  /** Platform identifier, where provided by TfNSW. */
  platform: string | null;
  /** ISO 8601 scheduled time. */
  time: string;
}

/** A single leg of a journey (one vehicle ride or a walk/transfer connector). */
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
  /** True for walk/transfer connector legs. */
  isTransfer: boolean;
  /** Per-leg adult Opal fare where available. */
  fare: Fare | null;
}

/** A complete journey option from origin to destination. */
export interface Journey {
  /** Stable id for detail lookup. */
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

/** A single side of the fastest-vs-economical comparison. */
export interface ComparisonEntry {
  journeyId: string;
  travelTimeMinutes: number;
  totalFare: Fare | null;
  transferCount: number;
  modes: TransportMode[];
}

/** Side-by-side comparison of the fastest vs economical routes (Requirement 5). */
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

/** Result of route discovery + ranking. */
export interface RouteResult {
  /** Up to 5 journeys, ordered by departureTime. */
  journeys: Journey[];
  fastestId: string | null;
  economicalId: string | null;
  comparison: RouteComparison;
}

/** Consistent error envelope returned by the backend on failure. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}
