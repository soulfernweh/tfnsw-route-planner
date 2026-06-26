import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { normaliseLocations } from './normalise.js';
import type { LocationType } from '../domain/models.js';

// Feature: tfnsw-route-planner, Property 2: Normalised locations are complete
//
// Validates: Requirements 1.2
//
// For any upstream stop-finder payload, every `Location` returned by
// `normaliseLocations` has a non-empty `name` (string length > 0) and a `type`
// drawn from the valid `LocationType` set ('stop','station','platform','poi',
// 'address','suburb').
//
// Unlike Property 1 (which isolates the cap by generating only VALID entries),
// this property exercises the VALIDITY/COERCION boundary directly: the
// generator emits a MIX of EFA-shaped entries — some valid, some with
// missing/blank names, some with missing ids, and some carrying unknown/garbage
// `type` tokens. The normaliser is expected to DROP entries that cannot yield a
// valid Location (missing id or blank name) while COERCING the type of any
// surviving entry to a member of the valid set. Whatever survives must always
// be complete.

/** The set of valid normalised LocationType values (mirrors the union). */
const VALID_LOCATION_TYPES: ReadonlySet<LocationType> = new Set<LocationType>([
  'stop',
  'station',
  'platform',
  'poi',
  'address',
  'suburb',
]);

/** Raw EFA `type` tokens the normaliser recognises (drawn from EFA_TYPE_MAP). */
const KNOWN_TYPE_TOKEN_ARB: fc.Arbitrary<string> = fc.constantFrom(
  'stop',
  'stoppoint',
  'bus',
  'station',
  'platform',
  'gisPlatform',
  'poi',
  'poiHierarchy',
  'suburb',
  'locality',
  'postcode',
  'address',
  'street',
  'singlehouse',
  'crossing',
);

/**
 * Unknown / garbage `type` tokens (including non-string types). The normaliser
 * must coerce any of these to the generic 'stop' rather than emit an invalid
 * type, so a surviving entry is always complete regardless of its raw type.
 */
const UNKNOWN_TYPE_ARB: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(), // arbitrary free-form token (e.g. "unknown", "", random text)
  fc.constantFrom('unknown', 'banana', 'TRAIN_STATION', '???', 'parkAndRide'),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
);

/** A blank-ish string: empty or whitespace-only (must NOT yield a Location). */
const BLANK_STRING_ARB: fc.Arbitrary<string> = fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t ');

/** A coordinate `[lat, lng]` pair as EFA encodes it. */
const COORD_ARB: fc.Arbitrary<[number, number]> = fc.tuple(
  fc.double({ min: -90, max: 90, noNaN: true }),
  fc.double({ min: -180, max: 180, noNaN: true }),
);

/**
 * A VALID entry: non-empty id + non-empty name, recognised type token. Should
 * always survive normalisation and be complete.
 */
const VALID_ENTRY_ARB: fc.Arbitrary<Record<string, unknown>> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
  name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
  type: KNOWN_TYPE_TOKEN_ARB,
  coord: fc.option(COORD_ARB, { nil: undefined }),
});

/**
 * An entry with a valid id+name but an UNKNOWN/garbage type. Should survive
 * (id+name are valid) and have its type coerced to the valid set.
 */
const UNKNOWN_TYPE_ENTRY_ARB: fc.Arbitrary<Record<string, unknown>> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
  name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
  type: UNKNOWN_TYPE_ARB,
});

/**
 * An entry with a BLANK or MISSING name. Must be DROPPED (a Location requires a
 * non-empty name per Req 1.2).
 */
const BLANK_NAME_ENTRY_ARB: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  // Explicit blank/whitespace name.
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    name: BLANK_STRING_ARB,
    type: KNOWN_TYPE_TOKEN_ARB,
  }),
  // Name field entirely absent.
  fc.record(
    {
      id: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
      type: KNOWN_TYPE_TOKEN_ARB,
    },
    { requiredKeys: ['id', 'type'] },
  ),
);

/**
 * An entry with a MISSING/blank id (but a valid name). Must be DROPPED (the
 * normaliser requires a non-empty id).
 */
const MISSING_ID_ENTRY_ARB: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({
    id: BLANK_STRING_ARB,
    name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
    type: KNOWN_TYPE_TOKEN_ARB,
  }),
  fc.record(
    {
      name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
      type: KNOWN_TYPE_TOKEN_ARB,
    },
    { requiredKeys: ['name', 'type'] },
  ),
);

/** A junk (non-object) entry: must be dropped without throwing. */
const JUNK_ENTRY_ARB: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.array(fc.anything(), { maxLength: 3 }),
);

/** A mixed entry drawn from all the categories above. */
const MIXED_ENTRY_ARB: fc.Arbitrary<unknown> = fc.oneof(
  VALID_ENTRY_ARB,
  UNKNOWN_TYPE_ENTRY_ARB,
  BLANK_NAME_ENTRY_ARB,
  MISSING_ID_ENTRY_ARB,
  JUNK_ENTRY_ARB,
);

/** An EFA stop-finder payload `{ locations: [...] }` with a mix of entries. */
const EFA_PAYLOAD_ARB = fc
  .array(MIXED_ENTRY_ARB, { minLength: 0, maxLength: 30 })
  .map((locations) => ({ locations }));

describe('normaliseLocations completeness (Property 2)', () => {
  it('every returned Location has a non-empty name and a valid type', () => {
    fc.assert(
      fc.property(EFA_PAYLOAD_ARB, (payload) => {
        const result = normaliseLocations(payload);

        for (const loc of result) {
          // Non-empty name (Req 1.2). The normaliser also trims, so a returned
          // name must contain non-whitespace content.
          expect(typeof loc.name).toBe('string');
          expect(loc.name.length).toBeGreaterThan(0);
          expect(loc.name.trim().length).toBeGreaterThan(0);

          // Type is drawn from the valid LocationType set (Req 1.2), even when
          // the raw entry carried an unknown/garbage type token.
          expect(VALID_LOCATION_TYPES.has(loc.type)).toBe(true);

          // A returned Location always carries a non-empty id as well (the
          // normaliser drops entries that lack one).
          expect(typeof loc.id).toBe('string');
          expect(loc.id.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('drops entries with blank or missing names', () => {
    const result = normaliseLocations({
      locations: [
        { id: 'a', name: 'Central Station', type: 'station' },
        { id: 'b', name: '   ', type: 'stop' }, // whitespace-only name -> dropped
        { id: 'c', type: 'stop' }, // missing name -> dropped
        { id: 'd', name: '', type: 'stop' }, // empty name -> dropped
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Central Station');
  });

  it('drops entries with a missing or blank id', () => {
    const result = normaliseLocations({
      locations: [
        { name: 'No Id Stop', type: 'stop' }, // missing id -> dropped
        { id: '  ', name: 'Blank Id Stop', type: 'stop' }, // blank id -> dropped
        { id: 'ok', name: 'Good Stop', type: 'stop' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('ok');
  });

  it('coerces unknown type tokens to a valid LocationType', () => {
    const result = normaliseLocations({
      locations: [
        { id: 'a', name: 'Mystery Place', type: 'banana' },
        { id: 'b', name: 'No Type Place' }, // missing type
        { id: 'c', name: 'Number Type', type: 42 },
      ],
    });
    expect(result).toHaveLength(3);
    for (const loc of result) {
      expect(VALID_LOCATION_TYPES.has(loc.type)).toBe(true);
    }
  });

  it('returns complete locations while silently dropping invalid neighbours', () => {
    const result = normaliseLocations({
      locations: [
        null,
        'garbage',
        { id: 'a', name: 'Valid Stop', type: 'stop' },
        { id: 'b', name: '   ' },
        42,
        { id: 'c', name: 'Another Valid', type: 'unknownToken' },
      ],
    });
    expect(result).toHaveLength(2);
    for (const loc of result) {
      expect(loc.name.length).toBeGreaterThan(0);
      expect(VALID_LOCATION_TYPES.has(loc.type)).toBe(true);
    }
  });
});
