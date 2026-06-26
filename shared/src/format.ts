// Presentation/formatting helpers shared by both the backend and the frontend
// (task 2.1). These live in @tfnsw/shared so the frontend's RouteComparisonView
// (task 11.8) can reuse the exact same formatting logic the backend uses.
//
// All functions are PURE: they depend only on their inputs and have no side
// effects, which makes them trivially testable (see the property test in task
// 2.2 validating Property 11).

/**
 * Formats an integer amount of cents as an AUD amount string with exactly two
 * decimal places.
 *
 * Money is carried through the system as integer cents (`Fare.amountCents`) to
 * avoid floating-point rounding errors; formatting to a two-decimal string only
 * happens here, at the presentation boundary.
 *
 * The numeric value of the returned string equals `cents / 100`, e.g.
 *   formatAud(1234) === "12.34"
 *   formatAud(5)    === "0.05"
 *   formatAud(0)    === "0.00"
 *   formatAud(100)  === "1.00"
 *
 * Computation uses integer arithmetic (not `cents / 100`) so the result is exact
 * for any integer input and never subject to binary floating-point rounding.
 *
 * @param cents - An integer number of cents.
 * @returns The amount formatted with exactly two decimal places.
 */
export function formatAud(cents: number): string {
  // Defensive: collapse a non-finite input to zero rather than emit "NaN".
  const safeCents = Number.isFinite(cents) ? Math.trunc(cents) : 0;

  const sign = safeCents < 0 ? '-' : '';
  const absCents = Math.abs(safeCents);

  const dollars = Math.floor(absCents / 100);
  const remainder = absCents % 100;

  return `${sign}${dollars}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * Formats a non-negative count of minutes into a compact hours-and-minutes
 * string, e.g.
 *   formatDuration(75) === "1h 15m"
 *   formatDuration(60) === "1h"
 *   formatDuration(45) === "45m"
 *   formatDuration(0)  === "0m"
 *
 * The output recomposes to the original minutes value: parsing the hours and
 * minutes components and computing `hours * 60 + minutes` yields the input
 * (see Property 11).
 *
 * @param minutes - A non-negative number of minutes.
 * @returns The duration formatted as hours and/or minutes.
 */
export function formatDuration(minutes: number): string {
  // Defensive: collapse non-finite or negative inputs to zero.
  const safeMinutes =
    Number.isFinite(minutes) && minutes > 0 ? Math.trunc(minutes) : 0;

  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;

  if (hours === 0) {
    return `${mins}m`;
  }
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}
