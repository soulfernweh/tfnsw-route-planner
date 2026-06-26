// Live smoke test against the real Transport for NSW Trip Planner API.
//
// This is NOT part of the automated test suite (which is deterministic and
// offline). It is a manual, opt-in script that exercises the REAL upstream
// endpoints end to end to validate that:
//   - the API key + base URL in `.env` work,
//   - the Stop Finder response parses through the normaliser into Locations,
//   - the Trip response parses into Journeys with computed Opal fare estimates,
//   - the ranking engine selects a fastest + economical route.
//
// It deliberately lives outside Vitest collection (filename is not *.test.ts)
// and reaches the network, so run it explicitly:
//
//   npm run smoke            # from backend/
//   npm run smoke --workspace @tfnsw/backend   # from the repo root
//
// SECURITY: the API key is read from the gitignored `.env` and is NEVER printed.
// Only non-sensitive results (stop names, journey summaries) are logged.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { TfnswClient } from '../tfnsw/client.js';
import {
  buildComparison,
  selectEconomical,
  selectFastest,
} from '../domain/rankingEngine.js';
import { formatAud, formatDuration } from '@tfnsw/shared';
import type { Journey, Location } from '../domain/models.js';

/**
 * Minimal, dependency-free `.env` parser. Reads `KEY=VALUE` lines from the repo
 * root `.env` and returns them as a record. Quotes around values are stripped;
 * blank lines and `#` comments are ignored. Returns an empty record when no
 * `.env` exists (callers then fall back to the ambient environment).
 *
 * NOTE: this intentionally RETURNS the parsed values rather than mutating
 * `process.env`, so callers can pass them explicitly and OVERRIDE any stale
 * variable already present in the shell environment (e.g. a truncated key left
 * over from an earlier session).
 */
function parseDotEnv(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // backend/src/scripts -> repo root is three levels up.
  const envPath = resolvePath(here, '..', '..', '..', '.env');

  const result: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return result; // No .env file; rely on the ambient environment.
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') {
      result[key] = value;
    }
  }
  return result;
}

/** Pretty one-line summary of a journey for console output. */
function summariseJourney(journey: Journey): string {
  const modes = journey.modes.join(' → ');
  const fare =
    journey.totalFare === null
      ? 'fare n/a'
      : `$${formatAud(journey.totalFare.amountCents)} (est.)`;
  const transfers =
    journey.transferCount === 0
      ? 'direct'
      : `${String(journey.transferCount)} transfer(s)`;
  return `${formatDuration(journey.travelTimeMinutes)}  ${fare}  ${transfers}  [${modes}]`;
}

/** Run the live smoke test, returning a process exit code. */
async function main(): Promise<number> {
  const env = parseDotEnv();
  // Prefer the .env file value, then the ambient environment. Reading the file
  // explicitly avoids a stale/truncated `TFNSW_API_KEY` in the shell shadowing
  // the real key (neither Node's --env-file nor a guarded loader overrides an
  // already-set variable).
  const apiKey = env['TFNSW_API_KEY'] ?? process.env['TFNSW_API_KEY'] ?? '';
  const baseUrl =
    env['TFNSW_BASE_URL'] ?? process.env['TFNSW_BASE_URL'] ?? undefined;

  if (apiKey.trim() === '') {
    console.error(
      '✗ TFNSW_API_KEY is not set.\n' +
        '  Put your key in the gitignored .env at the repo root:\n' +
        '    TFNSW_API_KEY=your-key-here\n' +
        '    TFNSW_BASE_URL=https://api.transport.nsw.gov.au/v1/tp/\n',
    );
    return 1;
  }

  const client = new TfnswClient({
    // Pass the key/URL explicitly (overriding any stale shell env var).
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    // Generous timeouts for a live smoke test over real network latency
    // (the production defaults of 3s/5s are intentionally tight for the API).
    stopFinderTimeoutMs: 15_000,
    tripTimeoutMs: 20_000,
    retryDelayMs: 500,
  });

  // --- 1. Stop Finder: origin + destination -------------------------------
  const originQuery = process.env['SMOKE_ORIGIN'] ?? 'Central Station';
  const destinationQuery = process.env['SMOKE_DESTINATION'] ?? 'Town Hall Station';

  console.log(`\n① Stop Finder — origin query: "${originQuery}"`);
  const originResults: Location[] = await client.stopFinder(originQuery);
  if (originResults.length === 0) {
    console.error('✗ No locations returned for the origin query.');
    return 1;
  }
  originResults.slice(0, 3).forEach((loc, i) => {
    console.log(`   ${String(i + 1)}. ${loc.name} [${loc.type}] (id: ${loc.id})`);
  });

  console.log(`\n② Stop Finder — destination query: "${destinationQuery}"`);
  const destinationResults: Location[] = await client.stopFinder(destinationQuery);
  if (destinationResults.length === 0) {
    console.error('✗ No locations returned for the destination query.');
    return 1;
  }
  destinationResults.slice(0, 3).forEach((loc, i) => {
    console.log(`   ${String(i + 1)}. ${loc.name} [${loc.type}] (id: ${loc.id})`);
  });

  const origin = originResults[0]!;
  const destination = destinationResults[0]!;

  if (origin.id === destination.id) {
    console.error('✗ Origin and destination resolved to the same stop; pick different queries.');
    return 1;
  }

  // --- 2. Trip planner -----------------------------------------------------
  console.log(
    `\n③ Trip — ${origin.name} (${origin.id}) → ${destination.name} (${destination.id})`,
  );
  const journeys = await client.trip(origin.id, destination.id, new Date(), 'dep');
  if (journeys.length === 0) {
    console.error('✗ No journeys returned for the trip.');
    return 1;
  }
  journeys.forEach((journey, i) => {
    console.log(`   ${String(i + 1)}. ${summariseJourney(journey)}`);
  });

  // --- 3. Ranking + comparison --------------------------------------------
  const fastest = selectFastest(journeys);
  const economical = selectEconomical(journeys);
  const comparison = buildComparison(fastest, economical);

  console.log('\n④ Ranking');
  console.log(`   Fastest    : ${fastest ? summariseJourney(fastest) : 'n/a'}`);
  console.log(`   Economical : ${economical ? summariseJourney(economical) : 'n/a'}`);
  if (comparison.sameRoute) {
    console.log('   (the fastest route is also the most economical)');
  } else if (
    comparison.travelTimeDifferenceMinutes !== null &&
    comparison.fareDifferenceCents !== null
  ) {
    console.log(
      `   Difference : ${formatDuration(comparison.travelTimeDifferenceMinutes)} ` +
        `and $${formatAud(comparison.fareDifferenceCents)}`,
    );
  }

  console.log('\n✓ Live smoke test passed.\n');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Never print the error object wholesale (it could echo request details);
    // surface only a safe message.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Live smoke test failed: ${message}`);
    process.exitCode = 1;
  });
