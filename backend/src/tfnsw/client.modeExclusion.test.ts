import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { TfnswClient } from './client.js';
import type { FetchFn } from './client.js';
import type { SelectableMode } from '../domain/models.js';

// Property-based test for the TfNSW client's mode-exclusion URL mapping.
//
// Feature: tfnsw-route-planner, Property 16: Mode-exclusion mapping emits the
// complement of included modes
//
// Validates: Requirements 6.3
//
// The design's Property 16 is phrased over an included set S whose complement is
// excluded upstream. The Route Service performs the included->excluded
// conversion; the client is the precise, testable unit that maps the
// `excludedModes` set onto the upstream query params. This test drives the
// client with an injected fake `fetchFn` that captures the request URL (and
// returns a minimal valid trip body), then asserts, for any random subset of the
// seven selectable modes chosen as `excludedModes`:
//   (a) every excluded mode contributes `exclMOT_<code>=1`;
//   (b) every NON-excluded selectable mode contributes NO `exclMOT_<code>=1`;
//   (c) an empty excluded set emits neither `excludedMeans` nor any `exclMOT_`;
//   (d) a non-empty excluded set emits a single `excludedMeans=checkbox`.

const TEST_API_KEY = 'SECRET-TEST-KEY-modeExclusion';
const TEST_BASE_URL = 'https://example.test/v1/tp/';

/** The seven user-selectable modes and their EFA exclMOT_<code> mode codes. */
const MODE_CODE: Record<SelectableMode, number> = {
  train: 1,
  metro: 2,
  lightRail: 4,
  bus: 5,
  coach: 7,
  ferry: 9,
  school: 11,
};

const ALL_SELECTABLE_MODES = Object.keys(MODE_CODE) as SelectableMode[];

/** A minimal valid rapidJSON trip body the normaliser accepts. */
const VALID_TRIP_BODY = { journeys: [] };

/**
 * Build a `Response`-like object exposing only the members the client touches
 * (`ok`, `status`, `json`). Cast through `unknown` to `Response`.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Construct a client wired to a fake `fetchFn` that records every request URL
 * and always returns the minimal valid trip body. Returns the client plus the
 * captured-URL accumulator.
 */
function makeCapturingClient(): { client: TfnswClient; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchFn = (input) => {
    urls.push(String(input));
    return Promise.resolve(jsonResponse(VALID_TRIP_BODY, 200));
  };
  const client = new TfnswClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    fetchFn,
    retryDelayMs: 0,
  });
  return { client, urls };
}

describe('TfnswClient mode-exclusion mapping (Property 16, Requirements 6.3)', () => {
  it('emits exclMOT_<code>=1 for exactly the excluded modes, and excludedMeans only when non-empty', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A random subset of the seven selectable modes (deduplicated set).
        fc.subarray(ALL_SELECTABLE_MODES),
        async (excludedModes) => {
          const { client, urls } = makeCapturingClient();

          await client.trip({
            originId: 'A',
            destinationId: 'B',
            time: new Date('2024-01-01T00:00:00Z'),
            depArr: 'dep',
            excludedModes,
          });

          // Exactly one request was issued; inspect its captured URL.
          expect(urls).toHaveLength(1);
          const url = urls[0]!;
          const excluded = new Set(excludedModes);

          // (a) Each excluded mode contributes exclMOT_<code>=1.
          for (const mode of excludedModes) {
            expect(url).toContain(`exclMOT_${MODE_CODE[mode]}=1`);
          }

          // (b) Each non-excluded selectable mode contributes NO exclMOT param.
          for (const mode of ALL_SELECTABLE_MODES) {
            if (!excluded.has(mode)) {
              expect(url).not.toContain(`exclMOT_${MODE_CODE[mode]}=1`);
            }
          }

          if (excludedModes.length === 0) {
            // (c) Empty excluded set => no excludedMeans and no exclMOT_ at all.
            expect(url).not.toContain('excludedMeans');
            expect(url).not.toContain('exclMOT_');
          } else {
            // (d) Non-empty excluded set => a single excludedMeans=checkbox.
            expect(url).toContain('excludedMeans=checkbox');
            const occurrences = url.split('excludedMeans=checkbox').length - 1;
            expect(occurrences).toBe(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
