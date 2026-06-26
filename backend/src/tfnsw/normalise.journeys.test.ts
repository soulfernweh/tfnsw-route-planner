import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { normaliseJourneys } from './normalise.js';

// Feature: tfnsw-route-planner, Property 4: Journeys are capped at 5 and ordered by departure
//
// Validates: Requirements 2.2
//
// For any EFA trip payload `{ journeys: [...] }` containing N journeys (each
// built from valid legs whose stops carry ISO departure/arrival timestamps and
// whose `transportation.product.class` denotes a mode), `normaliseJourneys`:
//   - returns AT MOST 5 journeys (the MAX_JOURNEYS cap, Req 2.2), and
//   - returns them ordered by NON-DECREASING `departureTime`.
//
// The generator emits EFA-shaped journeys matching the verified efa11 schema:
//   - times live on the stops (`origin.departureTimePlanned/Estimated`,
//     `destination.arrivalTimePlanned/Estimated`), NOT on the leg;
//   - mode is carried by `transportation.product.class` (an integer code);
//   - `leg.duration` is in seconds and `leg.distance` is in metres.
// Every generated leg is VALID (parseable times, present stops) so each journey
// survives normalisation — isolating the cap + ordering behaviour from the
// validity/coercion behaviour exercised by other tests.

const MAX_JOURNEYS = 5;
const MS_PER_MINUTE = 60_000;

/** EFA `transportation.product.class` codes the normaliser maps to a mode. */
const CLASS_CODE_ARB: fc.Arbitrary<number> = fc.constantFrom(1, 2, 4, 5, 7, 9, 11);

/** A base epoch (ms) anchoring all generated timestamps to a realistic range. */
const BASE_EPOCH_MS = Date.parse('2025-01-01T00:00:00Z');

/** An offset (in minutes) from the base epoch; spread wide to exercise ordering. */
const OFFSET_MINUTES_ARB: fc.Arbitrary<number> = fc.integer({ min: 0, max: 7 * 24 * 60 });

/** Convert a minute-offset from the base epoch into an ISO 8601 UTC string. */
function isoAt(offsetMinutes: number): string {
  return new Date(BASE_EPOCH_MS + offsetMinutes * MS_PER_MINUTE).toISOString();
}

/**
 * Build a single VALID EFA-shaped leg starting at `startOffsetMinutes` from the
 * base epoch and lasting `legMinutes`. Times are placed on the stops (preferring
 * the planned/estimated fields the normaliser reads), mode via
 * `transportation.product.class`, plus `duration` (seconds) and `distance`
 * (metres). Returns the raw leg and its end offset so legs can be chained.
 */
function makeLeg(
  startOffsetMinutes: number,
  legMinutes: number,
  classCode: number,
  distanceMetres: number,
): { leg: Record<string, unknown>; endOffsetMinutes: number } {
  const endOffsetMinutes = startOffsetMinutes + legMinutes;
  const leg: Record<string, unknown> = {
    origin: {
      name: 'Origin Stop',
      departureTimePlanned: isoAt(startOffsetMinutes),
      departureTimeEstimated: isoAt(startOffsetMinutes),
    },
    destination: {
      name: 'Destination Stop',
      arrivalTimePlanned: isoAt(endOffsetMinutes),
      arrivalTimeEstimated: isoAt(endOffsetMinutes),
    },
    transportation: { product: { class: classCode } },
    duration: legMinutes * 60,
    distance: distanceMetres,
  };
  return { leg, endOffsetMinutes };
}

/**
 * A single VALID EFA journey: 1..3 chained legs. The first leg departs at
 * `departureOffsetMinutes` (which therefore becomes the journey's departureTime
 * after normalisation), and subsequent legs follow in time.
 */
const JOURNEY_ARB: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    departureOffsetMinutes: OFFSET_MINUTES_ARB,
    legs: fc.array(
      fc.record({
        legMinutes: fc.integer({ min: 1, max: 120 }),
        gapMinutes: fc.integer({ min: 0, max: 30 }),
        classCode: CLASS_CODE_ARB,
        distanceMetres: fc.integer({ min: 0, max: 60_000 }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  })
  .map(({ departureOffsetMinutes, legs }) => {
    const rawLegs: Record<string, unknown>[] = [];
    let cursor = departureOffsetMinutes;
    for (const spec of legs) {
      cursor += spec.gapMinutes;
      const { leg, endOffsetMinutes } = makeLeg(
        cursor,
        spec.legMinutes,
        spec.classCode,
        spec.distanceMetres,
      );
      rawLegs.push(leg);
      cursor = endOffsetMinutes;
    }
    return { legs: rawLegs };
  });

/** An EFA trip payload `{ journeys: [...] }` with N (0..~12) valid journeys. */
const EFA_TRIP_PAYLOAD_ARB = fc
  .array(JOURNEY_ARB, { minLength: 0, maxLength: 12 })
  .map((journeys) => ({ payload: { journeys }, n: journeys.length }));

describe('normaliseJourneys cap and ordering (Property 4)', () => {
  it('returns at most 5 journeys, ordered by non-decreasing departureTime', () => {
    fc.assert(
      fc.property(EFA_TRIP_PAYLOAD_ARB, ({ payload, n }) => {
        const result = normaliseJourneys(payload);

        // Cap: never more than 5, and exactly min(N, 5) for these all-valid
        // payloads (every generated journey is normalisable).
        expect(result.length).toBeLessThanOrEqual(MAX_JOURNEYS);
        expect(result.length).toBe(Math.min(n, MAX_JOURNEYS));

        // Ordering: departureTime is non-decreasing across the returned list.
        for (let i = 1; i < result.length; i += 1) {
          const prev = Date.parse(result[i - 1]!.departureTime);
          const curr = Date.parse(result[i]!.departureTime);
          expect(Number.isNaN(prev)).toBe(false);
          expect(Number.isNaN(curr)).toBe(false);
          expect(prev).toBeLessThanOrEqual(curr);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('caps a payload of 12 journeys at 5', () => {
    const journeys = Array.from({ length: 12 }, (_, i) => ({
      legs: [makeLeg(i * 10, 5, 1, 1000).leg],
    }));
    expect(normaliseJourneys({ journeys }).length).toBe(5);
  });

  it('orders out-of-order journeys by departure time', () => {
    // Three journeys supplied newest-first; expect them returned oldest-first.
    const journeys = [
      { legs: [makeLeg(300, 10, 1, 1000).leg] },
      { legs: [makeLeg(100, 10, 1, 1000).leg] },
      { legs: [makeLeg(200, 10, 1, 1000).leg] },
    ];
    const result = normaliseJourneys({ journeys });
    expect(result.map((j) => j.departureTime)).toEqual([
      isoAt(100),
      isoAt(200),
      isoAt(300),
    ]);
  });

  it('returns an empty list for zero journeys', () => {
    expect(normaliseJourneys({ journeys: [] })).toEqual([]);
  });
});
