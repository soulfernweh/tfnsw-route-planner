import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatAud, formatDuration } from './format';

// Feature: tfnsw-route-planner, Property 11: Formatting helpers are exact and reversible
//
// This file validates Property 11 from the design document for the shared
// presentation helpers in `shared/src/format.ts`.
//
// Validates: Requirements 5.2

/**
 * Recomposes a duration string produced by `formatDuration` back into a total
 * number of minutes. Supports the three output shapes: "Xh Ym", "Xh", "Ym".
 */
function parseDurationToMinutes(formatted: string): number {
  const hoursMatch = formatted.match(/(\d+)h/);
  const minsMatch = formatted.match(/(\d+)m/);
  const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
  const mins = minsMatch ? Number(minsMatch[1]) : 0;
  return hours * 60 + mins;
}

describe('Property 11: Formatting helpers are exact and reversible', () => {
  it('formatAud produces exactly two decimals whose value equals cents/100', () => {
    fc.assert(
      fc.property(
        // Any non-negative integer number of cents.
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (cents) => {
          const formatted = formatAud(cents);

          // Exactly two decimal places, no leading sign for non-negative input.
          expect(formatted).toMatch(/^\d+\.\d{2}$/);

          // The numeric value equals cents / 100, checked via exact integer
          // reconstruction to avoid binary floating-point rounding.
          const [dollarsPart, centsPart] = formatted.split('.');
          const reconstructedCents = Number(dollarsPart) * 100 + Number(centsPart);
          expect(reconstructedCents).toBe(cents);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('formatDuration produces hours/minutes that recompose to the original minutes', () => {
    fc.assert(
      fc.property(
        // Any non-negative number of minutes.
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (minutes) => {
          const formatted = formatDuration(minutes);
          expect(parseDurationToMinutes(formatted)).toBe(minutes);
        },
      ),
      { numRuns: 100 },
    );
  });
});
