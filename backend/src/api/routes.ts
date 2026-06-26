// REST controllers for the TfNSW Route Planner backend (task 9.2).
//
// This module wires the `LocationService` and `RouteService` behind two public,
// read-only HTTP endpoints and applies the cross-cutting protections built in
// task 9.1 (validation, rate limiting, CORS). It is intentionally split into:
//
//   1. A FRAMEWORK-AGNOSTIC core — `handleApiRequest(ctx, deps)` — that takes a
//      plain request context (method, url, origin, ip) and returns a plain
//      `ApiResponse` (status + headers + body). This keeps the routing,
//      validation, error-mapping, caching, and CORS logic pure and trivially
//      unit/integration testable without sockets (see task 9.3).
//   2. A NODE ADAPTER — `createNodeRequestListener(deps)` — that bridges the
//      core to Node's built-in `http` server (`server.ts`, no Express needed).
//
// Endpoints (design "REST API Endpoints"):
//   - GET /api/locations?query=            → Location[]   (Req 1.1)
//   - GET /api/routes?originId=&destinationId=&time=
//                                          → RouteResult  (Req 2.2, 3.2, 4.2, 5.5)
//
// There is intentionally NO journey-detail-by-id endpoint: the TfNSW trip API
// has no journey id, and `/api/routes` already returns full leg-by-leg detail
// for every journey, so the detail/comparison views (Req 3.2/4.2/5.5) render
// from the already-fetched result. A failure to produce that detail is part of
// the `/api/routes` request outcome (Req 3.4), surfaced via the error envelope.
//
// SECURITY (design "Security" → "Unauthenticated public endpoints"): these
// endpoints are DELIBERATELY UNAUTHENTICATED — the product has no user accounts.
// This is a recorded design decision, not an oversight. Because each request
// proxies a keyed, rate-limited third-party API, the endpoints are protected by
// (a) strict input validation/allowlisting, (b) per-IP + global rate limiting,
// and (c) CORS restricted to ALLOWED_ORIGINS. The TfNSW API key and raw upstream
// payloads are never surfaced: typed errors are mapped through the safe
// `toErrorEnvelope`/`toHttpStatus` helpers, and any unexpected error collapses
// to a generic internal error.
//
// Design reference: .kiro/specs/tfnsw-route-planner/design.md
//   ("REST API Endpoints", "Security", "Caching Strategy", "Error Handling").
// Requirements: 1.1, 2.2, 3.2, 4.2, 5.5, 3.4.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { LocationService, RouteService } from '../domain/models.js';
import { toErrorEnvelope, toHttpStatus } from '../domain/errors.js';
import { STOP_FINDER_TTL_MS } from '../infra/cache.js';
import {
  corsHeaders,
  validateLocationQuery,
  validateRouteParams,
  type RateLimiter,
} from './middleware.js';

// ---------------------------------------------------------------------------
// Cache-Control policy (design "Caching Strategy")
// ---------------------------------------------------------------------------

/**
 * `Cache-Control` max-age for `/api/locations`, in seconds. Tied to the
 * stop-finder TTL (~24h) because location data changes infrequently, so the SPA
 * may briefly cache autocomplete results client-side too.
 */
export const LOCATIONS_MAX_AGE_SECONDS = Math.floor(STOP_FINDER_TTL_MS / 1000);

/**
 * `Cache-Control` max-age for `/api/routes`, in seconds. Short (~60s) because
 * schedules and the implicit "now" change quickly, matching the trip cache TTL.
 */
export const ROUTES_MAX_AGE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Framework-agnostic request/response shapes
// ---------------------------------------------------------------------------

/** The minimal request context the routing core needs. */
export interface ApiRequestContext {
  /** HTTP method, e.g. `'GET'` or `'OPTIONS'`. */
  method: string;
  /** Request target as received (path + query), e.g. `/api/locations?query=x`. */
  url: string;
  /** The request `Origin` header value, if any (for CORS). */
  origin: string | undefined;
  /** A stable per-client key for rate limiting (typically the remote IP). */
  ip: string;
}

/** A fully-resolved HTTP response produced by the routing core. */
export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** Serialised body (JSON for data/errors; empty string for 204). */
  body: string;
}

/** Dependencies the REST layer wires together. */
export interface RouteHandlerDeps {
  locationService: LocationService;
  routeService: RouteService;
  /** Per-IP + global rate limiter (see {@link createRateLimiter}). */
  rateLimiter: RateLimiter;
  /** Allowlisted CORS origins (see {@link parseAllowedOrigins}). */
  allowedOrigins: readonly string[];
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Build a JSON `ApiResponse`, merging the supplied header groups. */
function jsonResponse(
  status: number,
  payload: unknown,
  ...headerGroups: ReadonlyArray<Record<string, string>>
): ApiResponse {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  for (const group of headerGroups) {
    Object.assign(headers, group);
  }
  return { status, headers, body: JSON.stringify(payload) };
}

/** Build an error `ApiResponse` from any thrown value, never leaking detail. */
function errorResponse(
  error: unknown,
  ...headerGroups: ReadonlyArray<Record<string, string>>
): ApiResponse {
  return jsonResponse(toHttpStatus(error), toErrorEnvelope(error), ...headerGroups);
}

// ---------------------------------------------------------------------------
// Routing core (framework-agnostic)
// ---------------------------------------------------------------------------

/**
 * Resolve a single API request to an {@link ApiResponse}.
 *
 * Flow:
 *  1. Compute CORS headers for the request origin (always attached so browsers
 *     can read both success and error responses from allowed origins).
 *  2. Answer `OPTIONS` preflight immediately with `204 No Content`.
 *  3. Apply rate limiting; a blocked request yields `429` with `Retry-After`
 *     (seconds) and does not touch the services or upstream API.
 *  4. Dispatch `GET /api/locations` and `GET /api/routes`; validate inputs and
 *     map any thrown typed error through the safe envelope. Unknown paths →
 *     404; unsupported methods on known paths → 405.
 */
export async function handleApiRequest(
  ctx: ApiRequestContext,
  deps: RouteHandlerDeps,
): Promise<ApiResponse> {
  const cors = corsHeaders(ctx.origin, deps.allowedOrigins);

  // (2) CORS preflight: no body, just the negotiated CORS headers.
  if (ctx.method === 'OPTIONS') {
    return { status: 204, headers: cors, body: '' };
  }

  // Parse the target once. A relative `url` is resolved against a dummy base so
  // we get a `URL` with a `pathname` and `searchParams` without trusting Host.
  const parsed = new URL(ctx.url, 'http://localhost');
  const path = parsed.pathname;

  // (3) Rate limiting (per-IP + global). Applied before any service/upstream
  // work so abusive clients cannot exhaust the shared TfNSW quota.
  const limit = deps.rateLimiter.check(ctx.ip);
  if (!limit.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((limit.retryAfterMs ?? 0) / 1000),
    );
    return jsonResponse(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' } },
      { 'Retry-After': String(retryAfterSeconds) },
      cors,
    );
  }

  // (4) Dispatch.
  if (path === '/api/locations') {
    if (ctx.method !== 'GET') {
      return methodNotAllowed(cors);
    }
    return handleLocations(parsed.searchParams, deps, cors);
  }

  if (path === '/api/routes') {
    if (ctx.method !== 'GET') {
      return methodNotAllowed(cors);
    }
    return handleRoutes(parsed.searchParams, deps, cors);
  }

  return jsonResponse(
    404,
    { error: { code: 'NOT_FOUND', message: 'The requested resource could not be found.' } },
    cors,
  );
}

/** `GET /api/locations?query=` → validated search → `Location[]`. */
async function handleLocations(
  params: URLSearchParams,
  deps: RouteHandlerDeps,
  cors: Record<string, string>,
): Promise<ApiResponse> {
  try {
    const { query } = validateLocationQuery(params);
    const locations = await deps.locationService.searchLocations(query);
    return jsonResponse(
      200,
      locations,
      { 'Cache-Control': `public, max-age=${String(LOCATIONS_MAX_AGE_SECONDS)}` },
      cors,
    );
  } catch (error) {
    return errorResponse(error, cors);
  }
}

/** `GET /api/routes?originId=&destinationId=&time=` → validated → `RouteResult`. */
async function handleRoutes(
  params: URLSearchParams,
  deps: RouteHandlerDeps,
  cors: Record<string, string>,
): Promise<ApiResponse> {
  try {
    const request = validateRouteParams(params);
    const result = await deps.routeService.planRoutes(request);
    return jsonResponse(
      200,
      result,
      { 'Cache-Control': `public, max-age=${String(ROUTES_MAX_AGE_SECONDS)}` },
      cors,
    );
  } catch (error) {
    return errorResponse(error, cors);
  }
}

/** Shared `405 Method Not Allowed` for known paths hit with a wrong method. */
function methodNotAllowed(cors: Record<string, string>): ApiResponse {
  return jsonResponse(
    405,
    { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported for this endpoint.' } },
    { Allow: 'GET, OPTIONS' },
    cors,
  );
}

// ---------------------------------------------------------------------------
// Node `http` adapter
// ---------------------------------------------------------------------------

/**
 * Build a Node `http` request listener that delegates to {@link handleApiRequest}.
 *
 * The listener extracts the method, url, origin, and client ip from the incoming
 * message, resolves the response via the framework-agnostic core, and writes it
 * back. Any synchronous/asynchronous failure in the core is itself mapped to a
 * safe error envelope so the socket always receives a well-formed response.
 *
 * Client IP: taken from the socket's `remoteAddress`. `X-Forwarded-For` is NOT
 * trusted by default because a spoofable header would let a client evade the
 * per-IP rate limit; terminate TLS / set the real client address at a trusted
 * proxy if deploying behind one.
 */
export function createNodeRequestListener(
  deps: RouteHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const ctx: ApiRequestContext = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      origin: headerValue(req.headers['origin']),
      ip: req.socket.remoteAddress ?? 'unknown',
    };

    handleApiRequest(ctx, deps)
      .then((response) => {
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      })
      .catch((error: unknown) => {
        // Defensive: the core already maps known errors, so reaching here means
        // an unexpected failure. Collapse to a generic envelope; leak nothing.
        const response = errorResponse(error);
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      });
  };
}

/** Collapse a possibly-array header value to its first string, or undefined. */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}
