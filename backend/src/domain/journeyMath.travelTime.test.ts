import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeTravelTimeMinutes } from './journeyMath.js';
import type { Leg, TransportMode } from './models.js';

// Feature: tfnsw-route-planner, Property 5: Travel time equals arrival minus
// departure including transfer waits
//
// Validates: Requirements 2.3, 3.3
//
// `computeTravelTimeMinutes(legs)` must equal the whole-minute difference
// between the FIRST leg's scheduled departure and the LAST leg's scheduled
// arrival. Because that span runs across the entire journey, it inherently
// includes any waiting time between legs (transfer waits).

// --- Helpers ---------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

/** A modest set of valid transport modes for generated legs. */
const MODE_ARB: fc.Arbitrary<TransportMode> = fc.constantFrom(
  'train',
  'metro',
  'bus',
  'ferry',
  'lightRail',
  'coach',
  'walk',
  'school',
  'other',
);

/** Build a minimal, valid `Leg` spanning the given epoch-millisecond window. */
function makeLeg(
  departureMs: number,
  arrivalMs: number,
  mode: TransportMode,
  isTransfer: boolean,
): Leg {
  const departureTime = new Date(departureMs).toISOString();
  const arrivalTime = new Date(arrivalMs).toISOString();
  return {
    origin: { locationName: 'Origin', platform: null, time: departureTime },
    destination: { locationName: 'Destination', platform: null, time: arrivalTime },
    mode,
    routeName: null,
    departureTime,
    arrivalTime,
    durationMinutes: Math.round((arrivalMs - departureMs) / MS_PER_MINUTE),
    isTransfer,
    fare: null,
  };
}

/**
 * Generator for an ordered, valid leg sequence with whole-minute-aligned ISO
 * 8601 times. Each leg has a non-negative duration, and consecutive legs are
 * separated by a non-negative gap (a transfer wait). Aligning everything to
 * whole minutes keeps the expected whole-minute difference exact.
 *
 * Yields `{ legs, expectedMinutes }` where `expectedMinutes` is the independent
 * ground-truth total (sum of every leg duration plus every inter-leg gap),
 * which by construction equals (lastArrival - firstDeparture) in minutes.
 */
const journeyArb: fc.Arbitrary<{ legs: Leg[]; expectedMinutes: number }> = fc
  .record({
    // Base departure, in minutes since the Unix epoch, kept within a sane
    // calendar range (roughly 2009-2035) so timestamps are realistic.
    startMinute: fc.integer({ min: 20_000_000, max: 34_000_000 }),
    // One spec per leg: how long the leg lasts, and how long to wait before it
    // (the wait before the very first leg is ignored).
    legSpecs: fc.array(
      fc.record({
        durationMinutes: fc.integer({ min: 0, max: 600 }),
        gapBeforeMinutes: fc.integer({ min: 0, max: 240 }),
      }),
      { minLength: 1, maxLength: 8 },
    ),
    modes: fc.array(MODE_ARB, { minLength: 1, maxLength: 8 }),
  })
  .map(({ startMinute, legSpecs, modes }) => {
    const legs: Leg[] = [];
    let cursorMs = startMinute * MS_PER_MINUTE;
    let expectedMinutes = 0;

    legSpecs.forEach((spec, index) => {
      // The gap before the first leg does not contribute to travel time.
      if (index > 0) {
        cursorMs += spec.gapBeforeMinutes * MS_PER_MINUTE;
        expectedMinutes += spec.gapBeforeMinutes;
      }
      const departureMs = cursorMs;
      const arrivalMs = departureMs + spec.durationMinutes * MS_PER_MINUTE;
      const mode = modes[index % modes.length]!;
      legs.push(makeLeg(departureMs, arrivalMs, mode, mode === 'walk'));
      expectedMinutes += spec.durationMinutes;
      cursorMs = arrivalMs;
    });

    return { legs, expectedMinutes };
  });

// --- Property 5 ------------------------------------------------------------

describe('computeTravelTimeMinutes (Property 5)', () => {
  it('equals the whole-minute span from first departure to last arrival, including transfer waits', () => {
    fc.assert(
      fc.property(journeyArb, ({ legs, expectedMinutes }) => {
        const result = computeTravelTimeMinutes(legs);

        // 1. Matches the independent ground-truth (durations + transfer waits).
        expect(result).toBe(expectedMinutes);

        // 2. Matches the direct whole-minute difference of the endpoints.
        const firstDeparture = Date.parse(legs[0]!.departureTime);
        const lastArrival = Date.parse(legs[legs.length - 1]!.arrivalTime);
        expect(result).toBe(Math.round((lastArrival - firstDeparture) / MS_PER_MINUTE));
      }),
      { numRuns: 200 },
    );
  });

  // A couple of concrete examples anchor the property with readable cases.
  it('returns 0 for a single zero-length leg', () => {
    const t = '2020-01-01T08:00:00.000Z';
    const leg = makeLeg(Date.parse(t), Date.parse(t), 'train', false);
    expect(computeTravelTimeMinutes([leg])).toBe(0);
  });

  it('includes the transfer wait between two legs', () => {
    // Leg 1: 08:00 -> 08:20 (20m). Wait 10m. Leg 2: 08:30 -> 08:55 (25m).
    // Total span 08:00 -> 08:55 = 55m (20 + 10 wait + 25).
    const legs = [
      makeLeg(Date.parse('2020-01-01T08:00:00Z'), Date.parse('2020-01-01T08:20:00Z'), 'train', false),
      makeLeg(Date.parse('2020-01-01T08:30:00Z'), Date.parse('2020-01-01T08:55:00Z'), 'bus', false),
    ];
    expect(computeTravelTimeMinutes(legs)).toBe(55);
  });
});
