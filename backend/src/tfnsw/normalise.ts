// EFA (Elektronische Fahrplanauskunft) response normaliser.
//
// This module is the ONLY component aware of the raw TfNSW EFA JSON shape. It
// maps verbose, nested EFA payloads into the clean, client-facing domain models
// declared in `../domain/models.js`. Everything above the normaliser works with
// normalised models only. See:
//   .kiro/specs/tfnsw-route-planner/design.md ("Components and Interfaces" →
//   TfnswClient, "Data Models", "Security" → Untrusted upstream data).
//
// Requirements covered by this file:
//   - 1.2: each normalised Location has a non-empty name and a valid LocationType,
//          carrying its served modes and matchQuality
//   - 1.3: served modes drive each Location's priority tier (prioritiseLocations)
//   - 1.4: matchQuality orders Locations within a priority tier
//   - 1.1: prioritiseLocations caps the ordered result at 10
//
// IMPORTANT — untrusted input:
//   EFA responses are treated as UNTRUSTED. The normaliser never assumes the
//   structure is well-formed; every field is probed and coerced defensively.
//   Entries that cannot yield a valid Location (e.g. a missing/blank name) are
//   skipped rather than producing a malformed model.

import type {
  Journey,
  Leg,
  LegStop,
  Location,
  LocationType,
  TransportMode,
} from '../domain/models.js';
import {
  computeTransferCount,
  computeTravelTimeMinutes,
  sumLegFares,
} from '../domain/journeyMath.js';
import { estimateLegFare } from '../fares/index.js';

/** Maximum number of prioritised locations returned to a client (Req 1.1). */
const MAX_LOCATIONS = 10;

/**
 * Mapping from EFA stop_finder `modes` integer codes to the normalised
 * `TransportMode`. This is the SAME `class` → mode table used for legs, but
 * restricted to the public-transport modes a stop can serve (Req 1.2 / design
 * "EFA Response Mapping"). Codes outside this table are unknown and dropped.
 */
const STOP_FINDER_MODE_MAP: Readonly<Record<number, TransportMode>> = {
  1: 'train',
  2: 'metro',
  4: 'lightRail',
  5: 'bus',
  7: 'coach',
  9: 'ferry',
  11: 'school',
};

/** The set of valid normalised location types (mirrors the LocationType union). */
const VALID_LOCATION_TYPES: ReadonlySet<LocationType> = new Set<LocationType>([
  'stop',
  'station',
  'platform',
  'poi',
  'address',
  'suburb',
]);

/**
 * Mapping from raw EFA location-type tokens to our normalised `LocationType`.
 *
 * EFA stop-finder entries carry a free-form `type` string (and sometimes an
 * `anyType`/`modes` hint). The common tokens observed from the TfNSW Open Data
 * stop-finder endpoint are mapped here; anything unrecognised falls back to
 * `'stop'`, the most generic transport location (see `toLocationType`).
 */
const EFA_TYPE_MAP: Readonly<Record<string, LocationType>> = {
  stop: 'stop',
  stoppoint: 'stop',
  bus: 'stop',
  station: 'station',
  platform: 'platform',
  gisplatform: 'platform',
  poi: 'poi',
  poihierarchy: 'poi',
  suburb: 'suburb',
  locality: 'suburb',
  postcode: 'suburb',
  address: 'address',
  street: 'address',
  singlehouse: 'address',
  crossing: 'address',
};

// ---------------------------------------------------------------------------
// Safe field accessors (defensive coercion for untrusted EFA input)
// ---------------------------------------------------------------------------

/** True when `value` is a non-null, non-array plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce an unknown value to a trimmed, non-empty string, or `null`.
 *
 * Accepts strings and finite numbers (ids frequently arrive as numbers). Any
 * other type — or a string that is empty/whitespace-only — yields `null`.
 */
function toNonEmptyString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * Coerce an unknown value to a finite number, or `null`.
 *
 * Accepts numbers directly and numeric strings (EFA frequently encodes
 * coordinates as strings). `NaN`/`Infinity` and non-numeric input yield `null`.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Map a raw EFA type token to a normalised `LocationType`.
 *
 * The token is lower-cased and looked up in `EFA_TYPE_MAP`. Unknown or absent
 * tokens fall back to `'stop'`, guaranteeing the output is always a member of
 * the valid `LocationType` set (Req 1.2).
 */
function toLocationType(rawType: unknown): LocationType {
  if (typeof rawType === 'string') {
    const mapped = EFA_TYPE_MAP[rawType.trim().toLowerCase()];
    if (mapped !== undefined && VALID_LOCATION_TYPES.has(mapped)) {
      return mapped;
    }
  }
  return 'stop';
}

/**
 * Extract the parent locality (suburb) name from an EFA entry, where present.
 *
 * EFA nests locality information under a `parent` object (which itself may have
 * a `parent`, forming a hierarchy). We walk up the parent chain looking for the
 * first parent whose type denotes a locality/suburb and return its name. If no
 * such parent is found, but a generic parent name exists, that is used as a
 * best-effort fallback. Returns `null` when nothing usable is present.
 */
function extractSuburb(entry: Record<string, unknown>): string | null {
  let current: unknown = entry['parent'];
  let firstParentName: string | null = null;

  // Bounded walk up the parent hierarchy (guard against cyclic/huge inputs).
  for (let depth = 0; depth < 8 && isObject(current); depth += 1) {
    const parent = current;
    const name = toNonEmptyString(parent['name']) ?? toNonEmptyString(parent['disassembledName']);

    if (name !== null && firstParentName === null) {
      firstParentName = name;
    }

    const parentType =
      typeof parent['type'] === 'string' ? parent['type'].trim().toLowerCase() : '';
    if (name !== null && (parentType === 'locality' || parentType === 'suburb' || parentType === 'postcode')) {
      return name;
    }

    current = parent['parent'];
  }

  return firstParentName;
}

/**
 * Extract a `{ lat, lng }` coordinate from an EFA entry, where present.
 *
 * EFA represents coordinates in two common shapes:
 *   - a `coord` array `[lat, lng]` (latitude first, per the TfNSW EFA format)
 *   - explicit `{ lat, lng }` / `{ latitude, longitude }` fields
 * Both are probed defensively. Returns `null` unless BOTH a finite latitude and
 * longitude can be recovered.
 */
function extractCoord(entry: Record<string, unknown>): { lat: number; lng: number } | null {
  const coord = entry['coord'];

  // Array shape: [lat, lng].
  if (Array.isArray(coord) && coord.length >= 2) {
    const lat = toFiniteNumber(coord[0]);
    const lng = toFiniteNumber(coord[1]);
    if (lat !== null && lng !== null) {
      return { lat, lng };
    }
  }

  // Object shape: { lat/latitude, lng/long/longitude }.
  if (isObject(coord)) {
    const lat = toFiniteNumber(coord['lat'] ?? coord['latitude']);
    const lng = toFiniteNumber(coord['lng'] ?? coord['long'] ?? coord['longitude']);
    if (lat !== null && lng !== null) {
      return { lat, lng };
    }
  }

  // Flat fields directly on the entry.
  const flatLat = toFiniteNumber(entry['lat'] ?? entry['latitude']);
  const flatLng = toFiniteNumber(entry['lng'] ?? entry['long'] ?? entry['longitude']);
  if (flatLat !== null && flatLng !== null) {
    return { lat: flatLat, lng: flatLng };
  }

  return null;
}

/**
 * Locate the array of raw location entries within an EFA stop-finder payload.
 *
 * The modern TfNSW EFA stop-finder returns `{ locations: [...] }`, while older
 * EFA variants nest entries under `stopFinder.points`. We probe the known
 * shapes defensively and return an empty array when none is found (rather than
 * throwing) so a malformed payload simply yields no locations.
 */
function extractLocationEntries(efa: unknown): unknown[] {
  if (Array.isArray(efa)) {
    return efa;
  }

  if (isObject(efa)) {
    // Modern shape: { locations: [...] }.
    if (Array.isArray(efa['locations'])) {
      return efa['locations'];
    }

    // Legacy shape: { stopFinder: { points: [...] | { point: ... } } }.
    const stopFinder = efa['stopFinder'];
    if (isObject(stopFinder)) {
      const points = stopFinder['points'];
      if (Array.isArray(points)) {
        return points;
      }
      if (isObject(points) && points['point'] !== undefined) {
        const point = points['point'];
        return Array.isArray(point) ? point : [point];
      }
    }
  }

  return [];
}

/**
 * Extract the served public-transport modes from an EFA stop-finder entry.
 *
 * EFA carries a `modes` array of integer `class` codes. Each code is mapped via
 * {@link STOP_FINDER_MODE_MAP} to a `TransportMode`; unknown codes are dropped,
 * and the result is de-duplicated while preserving first-seen order. Locations
 * that serve no transit (addresses, POIs, suburbs) yield an empty array.
 *
 * Used to drive both the priority tier (Req 1.3) and display.
 */
function extractModes(entry: Record<string, unknown>): TransportMode[] {
  const raw = entry['modes'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<TransportMode>();
  const modes: TransportMode[] = [];
  for (const code of raw) {
    const num = toFiniteNumber(code);
    if (num === null || !Number.isInteger(num)) {
      continue;
    }
    const mode = STOP_FINDER_MODE_MAP[num];
    if (mode !== undefined && !seen.has(mode)) {
      seen.add(mode);
      modes.push(mode);
    }
  }
  return modes;
}

/**
 * Extract the EFA `matchQuality` (higher = better) used to order results within
 * a priority tier (Req 1.4). Defaults to 0 when absent or non-numeric.
 */
function extractMatchQuality(entry: Record<string, unknown>): number {
  return toFiniteNumber(entry['matchQuality']) ?? 0;
}

/**
 * Normalise a single raw EFA entry into a `Location`, or `null` if it cannot
 * yield a valid one.
 *
 * A valid Location requires both a non-empty `id` and a non-empty `name`
 * (Req 1.2). Entries missing either are skipped by the caller. The `type` is
 * always coerced to a valid `LocationType`; `suburb` and `coord` are extracted
 * where present, else `null`.
 */
function normaliseLocationEntry(entry: unknown): Location | null {
  if (!isObject(entry)) {
    return null;
  }

  const name =
    toNonEmptyString(entry['name']) ??
    toNonEmptyString(entry['disassembledName']) ??
    toNonEmptyString(entry['displayName']);
  if (name === null) {
    return null;
  }

  const id = toNonEmptyString(entry['id']) ?? toNonEmptyString(entry['stopId']);
  if (id === null) {
    return null;
  }

  return {
    id,
    name,
    type: toLocationType(entry['type']),
    suburb: extractSuburb(entry),
    modes: extractModes(entry),
    matchQuality: extractMatchQuality(entry),
    coord: extractCoord(entry),
  };
}

/**
 * Normalise a raw EFA stop-finder response into the client-facing
 * `Location[]` domain model.
 *
 * Behaviour (Req 1.2):
 *  - The EFA input is treated as untrusted: every field is probed and coerced
 *    defensively, and unrecognised structure simply produces fewer/no results
 *    rather than throwing.
 *  - Entries that cannot produce a valid Location (missing id or blank name)
 *    are skipped.
 *  - Each returned Location has a non-empty `name` and a `type` from the valid
 *    `LocationType` set; `modes` and `matchQuality` are carried through (Req
 *    1.3, 1.4); `suburb` and `coord` are populated where available, else `null`.
 *  - ALL valid normalised locations are returned (no cap). Result ordering and
 *    the cap-at-10 are applied later by {@link prioritiseLocations}.
 *
 * @param efa - the raw EFA stop-finder response (untrusted, of unknown shape)
 * @returns all valid normalised locations, in upstream order
 */
export function normaliseLocations(efa: unknown): Location[] {
  const entries = extractLocationEntries(efa);
  const locations: Location[] = [];

  for (const entry of entries) {
    const location = normaliseLocationEntry(entry);
    if (location !== null) {
      locations.push(location);
    }
  }

  return locations;
}

// ---------------------------------------------------------------------------
// Location Prioritisation Algorithm (design: "Location Prioritisation
// Algorithm")
// ---------------------------------------------------------------------------

/**
 * Assign a priority tier (1 = best) to a normalised `Location` from its served
 * `modes` and `type`, per the design's Location Prioritisation Algorithm:
 *
 *   - Tier 1 — train or metro stations (`modes` includes `train` or `metro`).
 *   - Tier 2 — ferry wharves (`modes` includes `ferry`).
 *   - Tier 3 — bus stops (`modes` includes `bus`).
 *   - Tier 4 — other transit: light rail, coach, or school bus (`modes`
 *     includes any of these but none of the higher tiers).
 *   - Tier 5 — non-transit: addresses, POIs, suburbs, or no transit modes.
 *
 * A multi-mode location takes the LOWEST (best) tier among its modes.
 */
function priorityTier(location: Location): number {
  const modes = location.modes;
  if (modes.includes('train') || modes.includes('metro')) {
    return 1;
  }
  if (modes.includes('ferry')) {
    return 2;
  }
  if (modes.includes('bus')) {
    return 3;
  }
  if (modes.includes('lightRail') || modes.includes('coach') || modes.includes('school')) {
    return 4;
  }
  return 5;
}

/**
 * Order normalised locations for display and cap the list at 10 (Req 1.1, 1.3,
 * 1.4 / design "Location Prioritisation Algorithm").
 *
 * Pure function: assigns each location a priority tier (see {@link priorityTier})
 * and stable-sorts by `(tier ascending, matchQuality descending)`, so the most
 * relevant transit locations appear first and equal `(tier, matchQuality)`
 * entries retain their upstream order. The sorted list is then capped at the
 * first 10 entries.
 *
 * @param locations - the full set of normalised locations (uncapped)
 * @returns the prioritised locations, capped at 10
 */
export function prioritiseLocations(locations: Location[]): Location[] {
  // Decorate with the original index to guarantee a stable sort across engines.
  const decorated = locations.map((location, index) => ({
    location,
    index,
    tier: priorityTier(location),
  }));

  decorated.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.location.matchQuality !== b.location.matchQuality) {
      return b.location.matchQuality - a.location.matchQuality;
    }
    return a.index - b.index;
  });

  return decorated.slice(0, MAX_LOCATIONS).map((d) => d.location);
}

// ===========================================================================
// Journey normalisation (task 5.4)
// ===========================================================================
//
// Maps an EFA trip-response payload into the client-facing `Journey[]` domain
// model. Like the location normaliser above, this treats the EFA input as
// UNTRUSTED: every field is probed and coerced, legs/journeys that cannot be
// normalised are skipped, and a malformed payload simply yields fewer (or no)
// journeys rather than throwing.
//
// Requirements covered by this section:
//   - 2.2: journeys are ordered by departure time (the Route Service merge
//          window now owns the result count; no cap here)
//   - 2.3: travel time spans first departure to last arrival (incl. transfers)
//   - 4.2: total fare is the sum of per-leg estimated fares
//   - 4.3: per-leg Opal fares are computed from distance + mode
//   - 4.5: computed fares are estimates (via the Opal Fare Calculator)
//
// Verified against the efa11 Swagger schema (see design "EFA Response
// Mapping"):
//   - A journey carries only `legs`, `rating`, `isAdditional` — NO id. The
//     `Journey.id` is therefore backend-assigned (a stable content hash).
//   - Leg TIMES live on the stops, not the leg: the origin's
//     `departureTimePlanned` / `departureTimeEstimated` and the destination's
//     `arrivalTimePlanned` / `arrivalTimeEstimated` (ISO 8601 UTC). The
//     ESTIMATED (real-time) value is preferred over the PLANNED value.
//   - `leg.duration` is in SECONDS; `leg.distance` is in METRES.
//   - Mode is derived from `transportation.product.class` (integer code).
//   - Platform is not a dedicated field — it is derived from a stop's
//     `disassembledName` / `name` where one encodes a platform/stand/wharf.

/**
 * Mapping from EFA `transportation.product.class` integer codes to the
 * normalised `TransportMode`. Codes outside this table fall back to `'other'`.
 */
const CLASS_TO_MODE: Readonly<Record<number, TransportMode>> = {
  1: 'train',
  2: 'metro',
  4: 'lightRail',
  5: 'bus',
  7: 'coach',
  9: 'ferry',
  11: 'school',
  99: 'walk',
  100: 'walk',
  101: 'bicycle',
};

/**
 * Coerce an unknown value to a valid ISO 8601 timestamp string, or `null`.
 *
 * The value must be a non-empty string that `Date.parse` accepts; anything that
 * does not parse to a real instant is rejected so it can never poison the
 * downstream travel-time arithmetic (which parses these strings).
 */
function toIsoTime(value: unknown): string | null {
  const text = toNonEmptyString(value);
  if (text === null) {
    return null;
  }
  return Number.isNaN(Date.parse(text)) ? null : text;
}

/**
 * Pick a stop time, preferring the real-time ESTIMATED value over the PLANNED
 * value (design: "Use the estimated value when present, otherwise planned").
 * Returns `null` when neither is a usable ISO timestamp.
 */
function pickStopTime(
  stop: Record<string, unknown>,
  estimatedKey: string,
  plannedKey: string,
): string | null {
  return toIsoTime(stop[estimatedKey]) ?? toIsoTime(stop[plannedKey]);
}

/**
 * Derive the `TransportMode` from a leg's `transportation.product.class`.
 *
 * Walks the nested `transportation` → `product` → `class` path defensively and
 * maps the integer code via `CLASS_TO_MODE`. Any missing/unknown code yields
 * `'other'`, guaranteeing a valid `TransportMode`.
 */
function toTransportMode(transportation: unknown): TransportMode {
  if (!isObject(transportation)) {
    return 'other';
  }
  const product = transportation['product'];
  if (!isObject(product)) {
    return 'other';
  }
  const classCode = toFiniteNumber(product['class']);
  if (classCode === null || !Number.isInteger(classCode)) {
    return 'other';
  }
  return CLASS_TO_MODE[classCode] ?? 'other';
}

/**
 * Extract a human-readable route name from a leg's `transportation` block.
 *
 * Prefers `disassembledName` (e.g. "T1"), then `number` (e.g. "389"), then the
 * full `name`. Returns `null` for connector legs / where none is present.
 */
function extractRouteName(transportation: unknown): string | null {
  if (!isObject(transportation)) {
    return null;
  }
  return (
    toNonEmptyString(transportation['disassembledName']) ??
    toNonEmptyString(transportation['number']) ??
    toNonEmptyString(transportation['name'])
  );
}

/**
 * Derive a platform identifier from a stop's name fields, where one is encoded.
 *
 * EFA has no dedicated platform field; platform/stand/wharf info is embedded in
 * the `disassembledName` / `name` (e.g. "Central Station, Platform 16"). We
 * match the common "<descriptor> <token>" pattern and return the token (e.g.
 * "16", "A"). Returns `null` when no platform is encoded.
 */
function extractPlatform(stop: Record<string, unknown>): string | null {
  const candidates = [
    toNonEmptyString(stop['disassembledName']),
    toNonEmptyString(stop['name']),
  ];
  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }
    const match = /\b(?:platform|plat|stand|wharf|side|bay)\s+([0-9a-z]+)\b/i.exec(candidate);
    if (match !== null && match[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

/**
 * Build a normalised `LegStop` from a raw EFA stop, using `timeIso` (already
 * resolved estimated-or-planned) as the stop's time.
 */
function toLegStop(stop: Record<string, unknown>, timeIso: string): LegStop {
  const locationName =
    toNonEmptyString(stop['name']) ??
    toNonEmptyString(stop['disassembledName']) ??
    'Unknown';
  return {
    locationName,
    platform: extractPlatform(stop),
    time: timeIso,
  };
}

/**
 * Compute the great-circle distance in metres between two `[lat, lng]` points
 * using the haversine formula.
 */
function haversineMetres(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Derive a leg's travelled distance in metres from its `coords` polyline.
 *
 * The live TfNSW trip response does NOT carry a `leg.distance` field; instead
 * each leg includes a `coords` array of `[lat, lng]` points tracing the path.
 * We sum the haversine distance between consecutive valid points to recover an
 * approximate travelled distance, which the Opal fare calculator then maps to a
 * fare band. Returns `null` when fewer than two valid points are present.
 *
 * @param coords - the raw `leg.coords` value (untrusted)
 * @returns the approximate path length in metres, or `null`
 */
function polylineLengthMetres(coords: unknown): number | null {
  if (!Array.isArray(coords)) {
    return null;
  }

  const points: Array<[number, number]> = [];
  for (const point of coords) {
    if (Array.isArray(point) && point.length >= 2) {
      const lat = toFiniteNumber(point[0]);
      const lng = toFiniteNumber(point[1]);
      if (lat !== null && lng !== null) {
        points.push([lat, lng]);
      }
    }
  }

  if (points.length < 2) {
    return null;
  }

  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMetres(points[i - 1]!, points[i]!);
  }
  return Math.round(total);
}

/**
 * Normalise a single raw EFA leg into a domain `Leg`, or `null` if it cannot be
 * normalised (e.g. missing stops or unusable times).
 *
 * Times are read from the STOPS (origin departure / destination arrival),
 * preferring estimated over planned. `durationMinutes` comes from `leg.duration`
 * (seconds), falling back to the time span when absent. `distanceMetres` comes
 * from `leg.distance` (metres) when present, otherwise it is derived from the
 * `leg.coords` polyline (the live API omits `distance`). The per-leg `fare` is
 * computed via the Opal Fare Calculator (walk/bicycle connectors are never
 * priced).
 */
function normaliseLeg(rawLeg: unknown): Leg | null {
  if (!isObject(rawLeg)) {
    return null;
  }

  const origin = rawLeg['origin'];
  const destination = rawLeg['destination'];
  if (!isObject(origin) || !isObject(destination)) {
    return null;
  }

  const departureTime = pickStopTime(origin, 'departureTimeEstimated', 'departureTimePlanned');
  const arrivalTime = pickStopTime(destination, 'arrivalTimeEstimated', 'arrivalTimePlanned');
  if (departureTime === null || arrivalTime === null) {
    return null;
  }

  const mode = toTransportMode(rawLeg['transportation']);
  const isTransfer = mode === 'walk' || mode === 'bicycle';

  // Distance in metres (used for fare estimation). The live TfNSW API omits a
  // `leg.distance` field, so fall back to the length of the `coords` polyline
  // when the explicit distance is absent or invalid.
  const rawDistance = toFiniteNumber(rawLeg['distance']);
  const distanceMetres =
    rawDistance !== null && rawDistance >= 0
      ? rawDistance
      : polylineLengthMetres(rawLeg['coords']);

  // Duration in seconds → minutes; fall back to the stop-time span if absent.
  const durationSeconds = toFiniteNumber(rawLeg['duration']);
  const durationMinutes =
    durationSeconds !== null && durationSeconds >= 0
      ? Math.round(durationSeconds / 60)
      : Math.max(0, Math.round((Date.parse(arrivalTime) - Date.parse(departureTime)) / 60000));

  // Connector legs (walk/bicycle) are never priced; otherwise estimate from
  // distance + mode (a null distance yields a null fare inside the calculator).
  const fare = isTransfer ? null : estimateLegFare(distanceMetres ?? Number.NaN, mode);

  return {
    origin: toLegStop(origin, departureTime),
    destination: toLegStop(destination, arrivalTime),
    mode,
    routeName: extractRouteName(rawLeg['transportation']),
    departureTime,
    arrivalTime,
    durationMinutes,
    distanceMetres,
    isTransfer,
    fare,
  };
}

/**
 * Compute the distinct transport modes used by a journey, preserving the order
 * in which they first appear across the legs.
 */
function distinctModesInOrder(legs: Leg[]): TransportMode[] {
  const seen = new Set<TransportMode>();
  const modes: TransportMode[] = [];
  for (const leg of legs) {
    if (!seen.has(leg.mode)) {
      seen.add(leg.mode);
      modes.push(leg.mode);
    }
  }
  return modes;
}

/**
 * Compute a small, stable, deterministic content hash (djb2, base36) for a
 * string. Used to derive the SYNTHETIC journey id from the journey's content so
 * the same upstream journey yields the same id across requests.
 */
function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // Coerce to an unsigned 32-bit integer before stringifying.
  return (hash >>> 0).toString(36);
}

/**
 * Derive a backend-assigned SYNTHETIC journey id from the journey's legs/times.
 *
 * TfNSW supplies no journey id, so we hash the ordered leg signature (mode +
 * route + departure/arrival times). The `index` is mixed in to disambiguate the
 * rare case of two structurally identical journeys in one result set.
 */
function syntheticJourneyId(legs: Leg[], index: number): string {
  const signature = legs
    .map((leg) => `${leg.mode}|${leg.routeName ?? ''}|${leg.departureTime}|${leg.arrivalTime}`)
    .join('>>');
  return `j-${stableHash(`${index}:${signature}`)}`;
}

/**
 * Normalise a single raw EFA journey into a domain `Journey`, or `null` if it
 * cannot be normalised (no normalisable legs, or unusable leg times).
 *
 * The whole body is defensive: any unexpected structure yields `null` rather
 * than throwing, so one bad journey never aborts the whole response.
 */
function normaliseJourney(rawJourney: unknown, index: number): Journey | null {
  if (!isObject(rawJourney)) {
    return null;
  }

  const rawLegs = rawJourney['legs'];
  if (!Array.isArray(rawLegs)) {
    return null;
  }

  const legs: Leg[] = [];
  for (const rawLeg of rawLegs) {
    const leg = normaliseLeg(rawLeg);
    if (leg !== null) {
      legs.push(leg);
    }
  }

  // A journey must have at least one normalisable leg.
  if (legs.length === 0) {
    return null;
  }

  // Reuse the pure journey-math helpers. `computeTravelTimeMinutes` throws on an
  // empty list or unparseable times; both are already guarded above, but we
  // stay defensive in case of any edge case.
  let travelTimeMinutes: number;
  try {
    travelTimeMinutes = computeTravelTimeMinutes(legs);
  } catch {
    return null;
  }

  const departureTime = legs[0]!.departureTime;
  const arrivalTime = legs[legs.length - 1]!.arrivalTime;

  return {
    id: syntheticJourneyId(legs, index),
    legs,
    departureTime,
    arrivalTime,
    travelTimeMinutes,
    transferCount: computeTransferCount(legs),
    modes: distinctModesInOrder(legs),
    totalFare: sumLegFares(legs),
  };
}

/**
 * Locate the array of raw journey entries within an EFA trip-response payload.
 *
 * The verified efa11 trip response is `{ journeys: [...] }`. We probe that shape
 * (and tolerate a bare array) defensively, returning an empty array for any
 * other/malformed structure rather than throwing.
 */
function extractJourneyEntries(efa: unknown): unknown[] {
  if (Array.isArray(efa)) {
    return efa;
  }
  if (isObject(efa) && Array.isArray(efa['journeys'])) {
    return efa['journeys'];
  }
  return [];
}

/**
 * Normalise a raw EFA trip response into the client-facing `Journey[]` domain
 * model.
 *
 * Behaviour (Req 2.2, 2.3, 4.2, 4.3, 4.5):
 *  - The EFA input is treated as untrusted: every field is probed and coerced,
 *    and unrecognised structure simply yields fewer/no journeys (never throws).
 *  - Each journey is assigned a backend SYNTHETIC `id` (TfNSW supplies none).
 *  - Leg times come from the stops (estimated preferred over planned); each
 *    leg's `durationMinutes` is from `leg.duration` (seconds), `distanceMetres`
 *    from `leg.distance` (metres), `mode` from `transportation.product.class`.
 *  - Per-leg `fare` is the estimated adult Opal fare (walk/bicycle => null);
 *    journey `travelTimeMinutes`, `transferCount`, `modes`, and `totalFare` are
 *    derived with the shared `journeyMath` helpers.
 *  - Journeys are ordered by non-decreasing `departureTime`. The result is NOT
 *    capped here — the Route Service's earlier+later merge window now owns the
 *    final count (design: "Route Service — Earlier + Later Window").
 *
 * @param efa - the raw EFA trip response (untrusted, of unknown shape)
 * @returns all normalised journeys, ordered by departure time
 */
export function normaliseJourneys(efa: unknown): Journey[] {
  const entries = extractJourneyEntries(efa);
  const journeys: Journey[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const journey = normaliseJourney(entries[index], index);
    if (journey !== null) {
      journeys.push(journey);
    }
  }

  // Order by non-decreasing departure time (stable sort). All departureTime
  // values are validated ISO timestamps, so Date.parse is finite.
  journeys.sort((a, b) => Date.parse(a.departureTime) - Date.parse(b.departureTime));

  return journeys;
}
