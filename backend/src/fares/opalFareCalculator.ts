// Opal Fare Calculator.
//
// Computes an ESTIMATED adult Opal fare for a single journey leg from the leg's
// distance (metres) and transport mode, using distance-band tables loaded as
// configuration data (NOT hard-coded here). This matches the design's
// `OpalFareCalculator` interface and the decision that fares are a
// distance-band estimate. See:
//   .kiro/specs/tfnsw-route-planner/design.md ("Opal Fare Calculator",
//   "Fare calculator scope (decision)").
//
// Requirements covered: 4.3 (compute per-leg Opal fare from distance + mode),
// 4.5 (fares are estimates; tables are reconcilable config data).
//
// IMPORTANT — fares are ESTIMATES:
//   The band boundaries and fare values live in `./data/opalFares.json` so they
//   can be updated when Opal pricing changes, without touching this logic. They
//   are seeded with recent published adult Opal figures and must be reconciled
//   against the official TfNSW Opal Fares dataset. Transfer discounts and
//   daily/weekly fare caps are out of scope.
//
// PURITY:
//   `estimateLegFare` is a pure function. The fare table is module-loaded config
//   (read once at import time); the function performs no I/O and mutates nothing.

import type { Fare, TransportMode } from '../domain/models.js';
import opalFares from './data/opalFares.json';

/**
 * A single distance band: a fare value that applies up to (and including) an
 * upper distance edge. `maxDistanceMetres === null` denotes the open-ended top
 * band that applies to any distance above the previous band's edge.
 */
interface FareBand {
  /** Inclusive upper edge of the band in metres, or `null` for the top band. */
  maxDistanceMetres: number | null;
  /** Adult Opal fare for this band, in integer cents (AUD). */
  fareCents: number;
}

/** Shape of the loaded Opal fares configuration. */
interface OpalFareConfig {
  currency: 'AUD';
  /** Maps a transport mode to the name of the fare table it uses. */
  modeToTable: Readonly<Record<string, string>>;
  /** Named fare tables, each an ascending-by-distance array of bands. */
  tables: Readonly<Record<string, readonly FareBand[]>>;
}

// The JSON also carries a leading `_note` documenting the estimate/reconcile
// caveat; it is not needed at runtime, so we read only the typed fields here.
const config = opalFares as unknown as OpalFareConfig;

/**
 * Estimate the adult Opal fare for a single priced leg.
 *
 * Mapping rules (per design + task 5.7):
 *  - `walk` and `bicycle` legs are connectors and are never priced → `null`.
 *  - Rail-based modes (`train`, `metro`, `lightRail`) share the `rail` distance
 *    bands; `bus` and `ferry` use their own bands. Any other mode without a
 *    configured table (e.g. `coach`, `school`, `other`) is unpriceable → `null`.
 *  - Within the mode's table, the distance falls into the FIRST band whose
 *    `maxDistanceMetres` is `null` (open-ended top band) or is `>=` the
 *    distance (upper edge inclusive). The matched band's fare is returned.
 *  - A negative or non-finite distance, or a distance that matches no band,
 *    yields `null`.
 *
 * The returned fare is an ESTIMATE (adult Opal). It does not apply transfer
 * discounts or daily/weekly caps.
 *
 * @param distanceMetres - the leg distance in metres
 * @param mode - the leg's transport mode
 * @returns an estimated `Fare`, or `null` when the leg is unpriceable
 */
export function estimateLegFare(
  distanceMetres: number,
  mode: TransportMode,
): Fare | null {
  // Connector legs are never priced.
  if (mode === 'walk' || mode === 'bicycle') {
    return null;
  }

  // A leg must have a usable, non-negative distance to be priced.
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0) {
    return null;
  }

  // Resolve the fare table for this mode (rail modes share the rail table).
  const tableName = config.modeToTable[mode];
  if (tableName === undefined) {
    return null;
  }
  const bands = config.tables[tableName];
  if (bands === undefined || bands.length === 0) {
    return null;
  }

  // Find the first band the distance falls into (upper edge inclusive; null is
  // the open-ended top band).
  for (const band of bands) {
    if (band.maxDistanceMetres === null || distanceMetres <= band.maxDistanceMetres) {
      return { amountCents: band.fareCents, currency: config.currency };
    }
  }

  // No band matched (e.g. a table with only finite edges that the distance
  // exceeds) — unpriceable.
  return null;
}
