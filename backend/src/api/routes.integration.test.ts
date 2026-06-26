// Integration tests for the WIRED backend (task 9.3).
//
// Unlike the per-component unit/property tests, this suite exercises the whole
// backend request path EXACTLY as production wires it — only the single
// network seam is faked:
//
//   fake fetchFn ─▶ real TfnswClient ─┬─▶ real DefaultLocationService ─┐
//   (recorded EFA)                    └─▶ real RouteService ───────────┤─▶ real handleApiRequest
//                       real createRateLimiter ────────────────────────┘
//
// The handler core (`handleApiRequest`) is driven DIRECTLY with a plain request
// context rather than opening a socket, so the tests stay deterministic and
// fast while still flowing through validation, rate limiting, CORS, the
// services, the real EFA normaliser, and the Opal fare calculator end to end.
// The ONLY injected fake is `fetchFn`, returning small RECORDED EFA-shaped
// payloads, so there is no real network I/O.
//
// Coverage:
//   (a) GET /api/locations          → 200 + normalised Location[]; the upstream
//       fetch carries `Authorization: apikey <key>` and outputFormat=rapidJSON.
//   (b) GET /api/routes             → 200 + RouteResult with per-leg Opal fare
//       estimates and a fastest/economical/comparison parsed from the EFA trip.
//   (c) Rate limiting               → 429 + Retry-After once the window is full.
//   (d) Validation errors           → 4xx + { error: { code, message } }; the
//       API key never appears in the body.
//
// _Requirements: 1.1, 2.2, Security, Design "Testing Strategy"_

import { describe, it, expect, vi } from 'vitest';

import { handleApiRequest, type ApiRequestContext, type RouteHandlerDeps } from './routes.js';
import { createRateLimiter, type RateLimiterOptions } from './middleware.js';
import { TfnswClient, type FetchFn } from '../tfnsw/client.js';
import { DefaultLocationService } from '../services/locationService.js';
import { RouteService } from '../services/routeService.js';
import type { Location, RouteResult } from '../domain/models.js';

// ---------------------------------------------------------------------------
// Test constants + recorded EFA-shaped payloads
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'SECRET-INTEGRATION-KEY-xyz789';
const TEST_BASE_URL = 'https://example.test/v1/tp/';
const CLIENT_IP = '203.0.113.7';

/**
 * Recorded `stop_finder` response (modern `{ locations: [...] }` shape). Two
 * entries with distinct types, parent localities, and `[lat, lng]` coords so
 * the location normaliser is exercised end to end.
 */
const STOP_FINDER_BODY = {
  locations: [
    {
      id: '10101100',
      name: 'Central Station',
      type: 'station',
      coord: [-33.883, 151.206],
      parent: { name: 'Sydney', type: 'locality' },
    },
    {
      id: '10101101',
      name: 'Central Chalmers Street, Light Rail',
      type: 'stop',
      coord: [-33.884, 151.204],
      parent: { name: 'Haymarket', type: 'suburb' },
    },
  ],
};

/**
 * Recorded `trip` response (`{ journeys: [{ legs: [...] }] }` shape). Two
 * single-leg journeys chosen so fastest != economical:
 *   - Journey TRAIN: class 1, 30 min, 15 000 m  → rail band ≤20 km = 522c.
 *   - Journey BUS:   class 5, 45 min,  2 000 m  → bus  band ≤3 km  = 320c.
 * The train is faster (30 < 45); the bus is cheaper (320 < 522). Times are on
 * the STOPS (departure on origin, arrival on destination) per the EFA mapping.
 */
const TRIP_BODY = {
  journeys: [
    {
      legs: [
        {
          duration: 1800,
          distance: 15000,
          transportation: { product: { class: 1 }, disassembledName: 'T1' },
          origin: {
            name: 'Central Station, Platform 16',
            departureTimePlanned: '2024-06-01T08:00:00Z',
          },
          destination: {
            name: 'Chatswood Station',
            arrivalTimePlanned: '2024-06-01T08:30:00Z',
          },
        },
      ],
    },
    {
      legs: [
        {
          duration: 2700,
          distance: 2000,
          transportation: { product: { class: 5 }, disassembledName: '389' },
          origin: {
            name: 'Central Station, Stand A',
            departureTimePlanned: '2024-06-01T08:10:00Z',
          },
          destination: {
            name: 'Bondi Junction',
            arrivalTimePlanned: '2024-06-01T08:55:00Z',
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Test wiring helpers
// ---------------------------------------------------------------------------

/** A minimal `Response`-like object exposing only what the client touches. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Route a faked upstream request to the recorded EFA payload by endpoint. */
function efaImplementation(url: RequestInfo | URL): Promise<Response> {
  const target = String(url);
  if (target.includes('stop_finder')) {
    return Promise.resolve(jsonResponse(STOP_FINDER_BODY));
  }
  if (target.includes('trip')) {
    return Promise.resolve(jsonResponse(TRIP_BODY));
  }
  return Promise.resolve(jsonResponse({}, 404));
}

/**
 * Build the REAL backend dependency graph with only `fetchFn` faked. Returns
 * the wired `deps` plus the `fetchFn` spy so tests can assert on the upstream
 * call (URL + headers). `rate` overrides the rate-limiter config.
 */
function makeDeps(rate?: Partial<RateLimiterOptions>): {
  deps: RouteHandlerDeps;
  fetchFn: ReturnType<typeof vi.fn>;
} {
  const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(efaImplementation);

  const client = new TfnswClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    fetchFn: fetchFn as unknown as FetchFn,
    retryDelayMs: 0,
  });

  const locationService = new DefaultLocationService(client);
  const routeService = new RouteService(client);

  const rateLimiter = createRateLimiter({
    windowMs: 60_000,
    maxPerWindow: 1000,
    globalMaxPerWindow: 100_000,
    ...rate,
  });

  return {
    deps: { locationService, routeService, rateLimiter, allowedOrigins: [] },
    fetchFn,
  };
}

/** Build a request context (defaults: GET, no origin, fixed client ip). */
function ctx(url: string, method = 'GET'): ApiRequestContext {
  return { method, url, origin: undefined, ip: CLIENT_IP };
}

// ---------------------------------------------------------------------------
// (a) GET /api/locations — normalised Location[] + secure upstream call
// ---------------------------------------------------------------------------

describe('Wired backend: GET /api/locations (Req 1.1, Security)', () => {
  it('returns 200 with a normalised Location[] parsed from the recorded EFA', async () => {
    const { deps } = makeDeps();

    const response = await handleApiRequest(ctx('/api/locations?query=central'), deps);

    expect(response.status).toBe(200);
    const locations = JSON.parse(response.body) as Location[];
    expect(locations).toHaveLength(2);
    // Normalisation ran end to end: ids, types, suburbs and coords are mapped.
    expect(locations[0]).toMatchObject({
      id: '10101100',
      name: 'Central Station',
      type: 'station',
      suburb: 'Sydney',
      coord: { lat: -33.883, lng: 151.206 },
    });
    expect(locations[1]).toMatchObject({ id: '10101101', type: 'stop', suburb: 'Haymarket' });
  });

  it('calls upstream with `Authorization: apikey <key>` and outputFormat=rapidJSON', async () => {
    const { deps, fetchFn } = makeDeps();

    await handleApiRequest(ctx('/api/locations?query=central'), deps);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`apikey ${TEST_API_KEY}`);

    const target = String(url);
    expect(target).toContain('outputFormat=rapidJSON');
    expect(target).toContain('name_sf=central');
  });
});

// ---------------------------------------------------------------------------
// (b) GET /api/routes — RouteResult with per-leg fares + ranking/comparison
// ---------------------------------------------------------------------------

describe('Wired backend: GET /api/routes (Req 2.2)', () => {
  it('returns 200 with a RouteResult carrying per-leg Opal fares and a comparison', async () => {
    const { deps } = makeDeps();

    const response = await handleApiRequest(
      ctx('/api/routes?originId=A&destinationId=B'),
      deps,
    );

    expect(response.status).toBe(200);
    const result = JSON.parse(response.body) as RouteResult;

    // The EFA trip parsed into two domain journeys, ordered by departure.
    expect(result.journeys).toHaveLength(2);
    const [train, bus] = result.journeys;

    // (b) a leg fare is present for a priced mode (computed estimate).
    expect(train!.legs[0]!.mode).toBe('train');
    expect(train!.legs[0]!.fare).toEqual({ amountCents: 522, currency: 'AUD' });
    expect(train!.totalFare).toEqual({ amountCents: 522, currency: 'AUD' });

    expect(bus!.legs[0]!.mode).toBe('bus');
    expect(bus!.legs[0]!.fare).toEqual({ amountCents: 320, currency: 'AUD' });

    // Ranking: the train is fastest (30 < 45 min); the bus is economical (320 < 522c).
    expect(result.fastestId).toBe(train!.id);
    expect(result.economicalId).toBe(bus!.id);

    // Comparison maths + labels are populated and internally consistent.
    expect(result.comparison.sameRoute).toBe(false);
    expect(result.comparison.fasterRouteId).toBe(train!.id);
    expect(result.comparison.cheaperRouteId).toBe(bus!.id);
    expect(result.comparison.travelTimeDifferenceMinutes).toBe(15);
    expect(result.comparison.fareDifferenceCents).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// (c) Rate limiting — 429 + Retry-After once the window is full
// ---------------------------------------------------------------------------

describe('Wired backend: rate limiting (Security)', () => {
  it('returns 429 with a Retry-After header once maxPerWindow is exceeded', async () => {
    // Low per-IP cap and a frozen clock so the window never resets mid-test.
    const { deps } = makeDeps({ maxPerWindow: 2, windowMs: 60_000, now: () => 1000 });

    const first = await handleApiRequest(ctx('/api/locations?query=central'), deps);
    const second = await handleApiRequest(ctx('/api/locations?query=central'), deps);
    const third = await handleApiRequest(ctx('/api/locations?query=central'), deps);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(third.status).toBe(429);
    expect(third.headers['Retry-After']).toBeDefined();
    expect(Number(third.headers['Retry-After'])).toBeGreaterThan(0);

    const body = JSON.parse(third.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// (d) Validation errors — 4xx envelope; API key never leaks into the body
// ---------------------------------------------------------------------------

describe('Wired backend: validation errors (Req 2.5, Security)', () => {
  it('rejects a missing query with 400 + { error: { code, message } } and no upstream call', async () => {
    const { deps, fetchFn } = makeDeps();

    const response = await handleApiRequest(ctx('/api/locations'), deps);

    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);

    // Validation short-circuits before any upstream/service work.
    expect(fetchFn).not.toHaveBeenCalled();
    // The API key never appears in the client-facing body.
    expect(response.body).not.toContain(TEST_API_KEY);
  });

  it('rejects identical origin and destination with 400 and never leaks the API key', async () => {
    const { deps } = makeDeps();

    const response = await handleApiRequest(
      ctx('/api/routes?originId=SAME&destinationId=SAME'),
      deps,
    );

    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body).not.toContain(TEST_API_KEY);
  });
});
