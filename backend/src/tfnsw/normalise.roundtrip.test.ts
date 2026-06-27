import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { normaliseLocations, normaliseJourneys } from './normalise.js';
import { computeTransferCount, computeTravelTimeMinutes } from '../domain/journeyMath.js';
import type {
  Journey,
  Leg,
  LegStop,
  Location,
  LocationType,
  TransportMode,
} from '../domain/models.js';

// Feature: tfnsw-route-planner, Property 14: EFA normalisation round-trip
//
// Validates: Requirements 1.2, 2.3
//
// For any valid domain `Location` or `Journey`, ENCODING it into an EFA-shaped
// payload using the verified field mappings (location `coord` as `[lat, lng]`,
// `type` enum mapping, leg times on the origin/destination stops via
// `departureTimePlanned`/`departureTimeEstimated` and
// `arrivalTimePlanned`/`arrivalTimeEstimated`, `leg.duration` in seconds,
// `leg.distance` in metres, and mode from `transportation.product.class`) and
// passing it through the normaliser reproduces an equivalent domain model for
// every field the TfNSW API carries.
//
// EXCLUDED from comparison (not part of the upstream payload):
//   - the synthetic `Journey.id`
//   - the computed `fare` (per leg) and `totalFare` (per journey)
//
// Strategy: generate domain models from primitives, derive BOTH the expected
// domain model and its EFA encoding from those primitives, then assert
//   normalise(encode(x)) === x   (on the carried fields).

// ---------------------------------------------------------------------------
// Mode <-> EFA product.class mapping (restricted to the invertible subset)
// ---------------------------------------------------------------------------
//
// We deliberately avoid class 100 (also 'walk') to keep the mapping a bijection
// over the modes we generate; the normaliser maps 99 -> walk and 101 -> bicycle
// uniquely, so each chosen class round-trips back to the intended mode.

const MODE_TO_CLASS: Readonly<Record<string, number>> = {
  train: 1,
  metro: 2,
  lightRail: 4,
  bus: 5,
  coach: 7,
  ferry: 9,
  school: 11,
  walk: 99,
  bicycle: 101,
};

const INVERTIBLE_MODES = Object.keys(MODE_TO_CLASS) as TransportMode[];

/**
 * Safe base location names. None contains a platform-keyword word
 * (platform/plat/stand/wharf/side/bay) that the normaliser's platform extractor
 * would pick up, so a stop with a null platform never accidentally yields one.
 */
const BASE_NAME_ARB: fc.Arbitrary<string> = fc.constantFrom(
  'Central',
  'Redfern',
  'Strathfield',
  'Parramatta',
  'Chatswood',
  'Hornsby',
  'Epping',
  'Museum',
  'Wynyard',
  'Newtown',
  'Ashfield',
  'Burwood',
);

/** ISO 8601 UTC timestamp (whole seconds) for an epoch-seconds value. */
function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ===========================================================================
// Property 14a: Location round-trip
// ===========================================================================

/** A finite latitude/longitude coordinate. */
const COORD_ARB: fc.Arbitrary<{ lat: number; lng: number }> = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true }),
  lng: fc.double({ min: -180, max: 180, noNaN: true }),
});

/** A trimmed, non-empty id string (no surrounding whitespace to survive trim). */
const ID_ARB: fc.Arbitrary<string> = fc.integer({ min: 1, max: 9_999_999 }).map((n) => `loc-${n}`);

/** A trimmed, non-empty display name. */
const NAME_ARB: fc.Arbitrary<string> = fc
  .tuple(BASE_NAME_ARB, fc.integer({ min: 0, max: 999 }))
  .map(([base, n]) => `${base} ${n}`);

/** A trimmed, non-empty suburb name (or null). */
const SUBURB_ARB: fc.Arbitrary<string | null> = fc.option(BASE_NAME_ARB, { nil: null });

/** Every valid normalised LocationType (each maps 1:1 to an EFA token of the same name). */
const LOCATION_TYPE_ARB: fc.Arbitrary<LocationType> = fc.constantFrom<LocationType>(
  'stop',
  'station',
  'platform',
  'poi',
  'address',
  'suburb',
);

/**
 * The public-transport modes a stop_finder entry can serve, paired with the EFA
 * `modes` integer `class` codes the normaliser maps them from (mirrors
 * STOP_FINDER_MODE_MAP in normalise.ts). Restricted to this invertible subset so
 * each generated mode encodes to a code that maps back to the same mode.
 */
const STOP_MODE_TO_CLASS: Readonly<Partial<Record<TransportMode, number>>> = {
  train: 1,
  metro: 2,
  lightRail: 4,
  bus: 5,
  coach: 7,
  ferry: 9,
  school: 11,
};

const STOP_MODES: TransportMode[] = Object.keys(STOP_MODE_TO_CLASS) as TransportMode[];

/**
 * A subset of served modes, in their canonical order. `fc.subarray` preserves
 * the source order and emits no duplicates, matching the normaliser's
 * first-seen, de-duplicated `extractModes` behaviour.
 */
const MODES_ARB: fc.Arbitrary<TransportMode[]> = fc.subarray(STOP_MODES);

/** A finite, non-negative match quality (higher = better). Defaults to 0 when absent. */
const MATCH_QUALITY_ARB: fc.Arbitrary<number> = fc.nat({ max: 1_000_000 });

const LOCATION_ARB: fc.Arbitrary<Location> = fc.record({
  id: ID_ARB,
  name: NAME_ARB,
  type: LOCATION_TYPE_ARB,
  suburb: SUBURB_ARB,
  modes: MODES_ARB,
  matchQuality: MATCH_QUALITY_ARB,
  coord: fc.option(COORD_ARB, { nil: null }),
});

/**
 * Encode a domain `Location` into an EFA stop-finder entry, using the verified
 * field mappings: `coord` as `[lat, lng]`, the type token equal to the
 * normalised type (each LocationType has an identity token in the EFA type
 * map), the suburb supplied via a `parent` locality, the served `modes` as their
 * EFA integer `class` codes, and `matchQuality` as-is.
 */
function encodeLocation(loc: Location): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: loc.id,
    name: loc.name,
    type: loc.type,
    modes: loc.modes.map((mode) => STOP_MODE_TO_CLASS[mode]),
    matchQuality: loc.matchQuality,
  };
  if (loc.suburb !== null) {
    entry['parent'] = { name: loc.suburb, type: 'suburb' };
  }
  if (loc.coord !== null) {
    entry['coord'] = [loc.coord.lat, loc.coord.lng];
  }
  return entry;
}

describe('EFA normalisation round-trip: Location (Property 14)', () => {
  it('reproduces every carried field of a domain Location', () => {
    fc.assert(
      fc.property(LOCATION_ARB, (loc) => {
        const efa = { locations: [encodeLocation(loc)] };
        const result = normaliseLocations(efa);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(loc);
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring example ------------------------------------------

  it('round-trips a fully-populated station location', () => {
    const loc: Location = {
      id: 'G12345',
      name: 'Central Station',
      type: 'station',
      suburb: 'Haymarket',
      modes: ['train', 'bus'],
      matchQuality: 950,
      coord: { lat: -33.883, lng: 151.206 },
    };
    const result = normaliseLocations({ locations: [encodeLocation(loc)] });
    expect(result).toEqual([loc]);
  });
});

// ===========================================================================
// Property 14b: Journey round-trip
// ===========================================================================

/** A stop spec: a base name plus an optional platform token. */
interface StopSpec {
  base: string;
  platform: string | null;
}

const STOP_SPEC_ARB: fc.Arbitrary<StopSpec> = fc.record({
  base: BASE_NAME_ARB,
  platform: fc.option(
    fc.integer({ min: 1, max: 60 }).map((n) => String(n)),
    { nil: null },
  ),
});

/** The display name encoded for a stop (embeds the platform where present). */
function stopName(spec: StopSpec): string {
  return spec.platform === null ? spec.base : `${spec.base} Platform ${spec.platform}`;
}

/** A single leg spec from which we derive both the domain leg and its EFA shape. */
interface LegSpec {
  mode: TransportMode;
  origin: StopSpec;
  destination: StopSpec;
  routeName: string | null;
  /** Seconds spent travelling this leg (drives the dep->arr gap). */
  rideSeconds: number;
  /** Seconds waited after this leg before the next (transfer dwell). */
  waitSeconds: number;
  /** EFA `leg.duration` in seconds (independent of the dep->arr span). */
  durationSeconds: number;
  /** EFA `leg.distance` in metres, or null when absent. */
  distanceMetres: number | null;
}

const LEG_SPEC_ARB: fc.Arbitrary<LegSpec> = fc.record({
  mode: fc.constantFrom(...INVERTIBLE_MODES),
  origin: STOP_SPEC_ARB,
  destination: STOP_SPEC_ARB,
  routeName: fc.option(BASE_NAME_ARB, { nil: null }),
  rideSeconds: fc.integer({ min: 0, max: 7200 }),
  waitSeconds: fc.integer({ min: 0, max: 3600 }),
  durationSeconds: fc.integer({ min: 0, max: 10_000 }),
  distanceMetres: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
});

/** A journey spec: a start time plus an ordered, non-empty list of leg specs. */
const JOURNEY_SPEC_ARB = fc.record({
  startSec: fc.integer({ min: 1_500_000_000, max: 1_800_000_000 }),
  legs: fc.array(LEG_SPEC_ARB, { minLength: 1, maxLength: 5 }),
});

/**
 * Build the expected domain `Leg` for a leg spec, with sequential dep/arr times.
 * Returns the full leg plus the cursor (epoch seconds) for the next leg.
 */
function buildDomainLeg(spec: LegSpec, cursorSec: number): { leg: Leg; nextCursorSec: number } {
  const departureSec = cursorSec;
  const arrivalSec = departureSec + spec.rideSeconds;
  const departureTime = isoFromSec(departureSec);
  const arrivalTime = isoFromSec(arrivalSec);

  const isTransfer = spec.mode === 'walk' || spec.mode === 'bicycle';

  const origin: LegStop = {
    locationName: stopName(spec.origin),
    platform: spec.origin.platform,
    time: departureTime,
  };
  const destination: LegStop = {
    locationName: stopName(spec.destination),
    platform: spec.destination.platform,
    time: arrivalTime,
  };

  const leg: Leg = {
    origin,
    destination,
    mode: spec.mode,
    routeName: spec.routeName,
    departureTime,
    arrivalTime,
    durationMinutes: Math.round(spec.durationSeconds / 60),
    distanceMetres: spec.distanceMetres,
    isTransfer,
    // Excluded from the carried-field comparison; placeholder only.
    fare: null,
  };

  return { leg, nextCursorSec: arrivalSec + spec.waitSeconds };
}

/**
 * Encode a leg spec (paired with its already-derived dep/arr times) into an
 * EFA-shaped leg, using the verified mappings: times on the stops
 * (`departureTimePlanned` / `arrivalTimePlanned`), mode via
 * `transportation.product.class`, `duration` in seconds, `distance` in metres.
 */
function encodeLeg(spec: LegSpec, departureTime: string, arrivalTime: string): Record<string, unknown> {
  const transportation: Record<string, unknown> = {
    product: { class: MODE_TO_CLASS[spec.mode] },
  };
  if (spec.routeName !== null) {
    transportation['disassembledName'] = spec.routeName;
  }

  const efaLeg: Record<string, unknown> = {
    origin: {
      name: stopName(spec.origin),
      departureTimePlanned: departureTime,
    },
    destination: {
      name: stopName(spec.destination),
      arrivalTimePlanned: arrivalTime,
    },
    transportation,
    duration: spec.durationSeconds,
  };
  if (spec.distanceMetres !== null) {
    efaLeg['distance'] = spec.distanceMetres;
  }
  return efaLeg;
}

/** Distinct modes in order of first appearance (mirrors the normaliser). */
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

/** Drop the per-leg `fare` (computed, not carried by the upstream payload). */
function carriedLeg(leg: Leg): Omit<Leg, 'fare'> {
  const { fare: _fare, ...rest } = leg;
  return rest;
}

/** Drop the synthetic `id` and computed `totalFare`, and strip leg fares. */
function carriedJourney(journey: Journey): Omit<Journey, 'id' | 'totalFare' | 'legs'> & {
  legs: Omit<Leg, 'fare'>[];
} {
  const { id: _id, totalFare: _totalFare, legs, ...rest } = journey;
  return { ...rest, legs: legs.map(carriedLeg) };
}

describe('EFA normalisation round-trip: Journey (Property 14)', () => {
  it('reproduces every carried field of a domain Journey', () => {
    fc.assert(
      fc.property(JOURNEY_SPEC_ARB, ({ startSec, legs: legSpecs }) => {
        // Build the expected domain legs with sequential, monotonic times.
        const domainLegs: Leg[] = [];
        const efaLegs: Record<string, unknown>[] = [];
        let cursor = startSec;
        for (const spec of legSpecs) {
          const { leg, nextCursorSec } = buildDomainLeg(spec, cursor);
          domainLegs.push(leg);
          efaLegs.push(encodeLeg(spec, leg.departureTime, leg.arrivalTime));
          cursor = nextCursorSec;
        }

        // The expected domain journey (carried fields only).
        const expected = carriedJourney({
          id: 'synthetic',
          legs: domainLegs,
          departureTime: domainLegs[0]!.departureTime,
          arrivalTime: domainLegs[domainLegs.length - 1]!.arrivalTime,
          travelTimeMinutes: computeTravelTimeMinutes(domainLegs),
          transferCount: computeTransferCount(domainLegs),
          modes: distinctModesInOrder(domainLegs),
          totalFare: null,
        });

        const result = normaliseJourneys({ journeys: [{ legs: efaLegs }] });

        expect(result).toHaveLength(1);
        expect(carriedJourney(result[0]!)).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });

  // --- Concrete anchoring example ------------------------------------------

  it('round-trips a two-leg train + bus journey', () => {
    const legSpecs: LegSpec[] = [
      {
        mode: 'train',
        origin: { base: 'Central', platform: '16' },
        destination: { base: 'Strathfield', platform: '4' },
        routeName: 'Strathfield',
        rideSeconds: 900,
        waitSeconds: 300,
        durationSeconds: 900,
        distanceMetres: 8000,
      },
      {
        mode: 'bus',
        origin: { base: 'Strathfield', platform: null },
        destination: { base: 'Burwood', platform: null },
        routeName: 'Burwood',
        rideSeconds: 600,
        waitSeconds: 0,
        durationSeconds: 600,
        distanceMetres: 3000,
      },
    ];

    const domainLegs: Leg[] = [];
    const efaLegs: Record<string, unknown>[] = [];
    let cursor = 1_700_000_000;
    for (const spec of legSpecs) {
      const { leg, nextCursorSec } = buildDomainLeg(spec, cursor);
      domainLegs.push(leg);
      efaLegs.push(encodeLeg(spec, leg.departureTime, leg.arrivalTime));
      cursor = nextCursorSec;
    }

    const expected = carriedJourney({
      id: 'synthetic',
      legs: domainLegs,
      departureTime: domainLegs[0]!.departureTime,
      arrivalTime: domainLegs[domainLegs.length - 1]!.arrivalTime,
      travelTimeMinutes: computeTravelTimeMinutes(domainLegs),
      transferCount: computeTransferCount(domainLegs),
      modes: distinctModesInOrder(domainLegs),
      totalFare: null,
    });

    const result = normaliseJourneys({ journeys: [{ legs: efaLegs }] });

    expect(result).toHaveLength(1);
    expect(carriedJourney(result[0]!)).toEqual(expected);
    // Sanity: the carried derived fields landed as intended.
    expect(result[0]!.modes).toEqual(['train', 'bus']);
    expect(result[0]!.transferCount).toBe(1);
    expect(result[0]!.legs[0]!.origin.platform).toBe('16');
  });
});
