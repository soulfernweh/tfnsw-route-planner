// HTTP-agnostic API middleware helpers: input validation/allowlisting, an
// in-memory rate limiter, and CORS header derivation.
//
// These are the building blocks the REST layer (task 9.2) mounts onto the
// chosen HTTP server. They are deliberately FRAMEWORK-AGNOSTIC and pure /
// deterministic where possible:
//
//   - Validation functions take a plain bag of query parameters (a
//     `URLSearchParams` or a plain record) and either return a clean,
//     allowlisted value object or throw a `ValidationError` (HTTP 400) from
//     the domain error module. They perform NO I/O and never touch a server.
//   - The rate limiter is a small factory returning a `check(ip)` function; its
//     time source is injectable (`now`) so tests can advance time without real
//     delays. It holds only in-memory counters.
//   - The CORS helper is a pure function from `(origin, allowedOrigins)` to the
//     response headers to set.
//
// SCOPE (task 9.1): this module does NOT start a server, define routes, or wire
// any service. That wiring is task 9.2 (`routes.ts` / `server.ts`).
//
// SECURITY (design "Security" → "Unauthenticated public endpoints"): because
// the `/api/locations` and `/api/routes` endpoints proxy a keyed, rate-limited
// third-party API without end-user auth, they MUST be protected by strict input
// validation (length bounds, allowlisted id/time formats), per-IP plus global
// rate limiting, and CORS restricted to the configured origins. These helpers
// implement exactly those protections.
//
// Design reference: .kiro/specs/tfnsw-route-planner/design.md
//   ("REST API Endpoints", "Security"). Requirements: 2.5.

import type { RouteRequest, SelectableMode, TransportMode } from '../domain/models.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Query parameter access (HTTP-agnostic)
// ---------------------------------------------------------------------------

/**
 * A bag of query parameters as produced by an HTTP server. Accepts either a
 * standard {@link URLSearchParams} (e.g. from `new URL(req.url, base)`) or a
 * plain object (e.g. a parsed query). Repeated keys collapse to the FIRST
 * value, which is the safe, predictable choice for allowlisted scalar params.
 */
export type QueryParams =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Read a single string value for `key` from a {@link QueryParams} bag,
 * regardless of its concrete shape. Returns `undefined` when the key is absent.
 * For array-valued plain-record entries, the first element is used.
 */
function getParam(params: QueryParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) {
    const value = params.get(key);
    return value === null ? undefined : value;
  }
  const raw = params[key];
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw[0] : (raw as string);
}

// ---------------------------------------------------------------------------
// Input validation / allowlisting
// ---------------------------------------------------------------------------

/** Minimum allowed length (after trimming) for the location search query. */
export const QUERY_MIN_LENGTH = 1;
/** Maximum allowed length (after trimming) for the location search query. */
export const QUERY_MAX_LENGTH = 100;

/**
 * Allowlist pattern for a TfNSW location id used as origin/destination. Limits
 * the id to a safe character set (alphanumerics plus `:`, `_`, `-`) and a
 * bounded length so malformed or injection-style values never reach the
 * upstream client.
 */
export const LOCATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;

/**
 * Pragmatic ISO 8601 date-time pattern: `YYYY-MM-DDTHH:MM` with optional
 * seconds, fractional seconds, and a `Z`/`±HH:MM` offset. Combined with a
 * `Date` parse check, this rejects free-form or malformed time inputs.
 */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** The validated, allowlisted shape of a `/api/locations` request. */
export interface ValidatedLocationQuery {
  /** The trimmed search query, guaranteed within the length bounds. */
  query: string;
}

/**
 * Validate and allowlist the `/api/locations` query parameters.
 *
 * Rules:
 *  - `query` is required, must be a string, and its TRIMMED length must fall
 *    within `[QUERY_MIN_LENGTH, QUERY_MAX_LENGTH]`.
 *
 * Note: the 3-character "short query" guard (Req 1.6) lives in the
 * `LocationService`, not here — this layer only enforces presence and length
 * bounds so absurd/empty inputs never reach the service or upstream API.
 *
 * @param params - the request query parameters
 * @returns the validated `{ query }`
 * @throws {ValidationError} when the query is missing or out of bounds
 */
export function validateLocationQuery(params: QueryParams): ValidatedLocationQuery {
  const raw = getParam(params, 'query');
  if (raw === undefined) {
    throw new ValidationError('The "query" parameter is required.');
  }

  const query = raw.trim();
  if (query.length < QUERY_MIN_LENGTH) {
    throw new ValidationError('The "query" parameter must not be empty.');
  }
  if (query.length > QUERY_MAX_LENGTH) {
    throw new ValidationError(
      `The "query" parameter must be at most ${String(QUERY_MAX_LENGTH)} characters.`,
    );
  }

  return { query };
}

/**
 * Validate and allowlist the `/api/routes` query parameters into a clean
 * {@link RouteRequest}.
 *
 * Rules:
 *  - `originId` and `destinationId` are required, non-empty, and must match the
 *    {@link LOCATION_ID_PATTERN} id allowlist.
 *  - `time` is OPTIONAL. When present it must be a valid ISO 8601 date-time;
 *    when absent it defaults to an empty string (the `RouteService` interprets
 *    an empty time as "depart now").
 *  - `when` is OPTIONAL (the Time_Filter). When present it must be one of
 *    `leaveNow | leaveAt | arriveBy`; when absent it defaults to `leaveNow`.
 *    It is mapped to `depArr`: `leaveNow`/`leaveAt` → `'dep'`, `arriveBy` →
 *    `'arr'` (Req 7.1-7.5).
 *  - `modes` is OPTIONAL (the Mode_Selection). It is a comma-separated list of
 *    selectable modes given as names (train/metro/lightRail/bus/coach/ferry/
 *    school) and/or numeric class codes (1/2/4/5/7/9/11, which map to those
 *    names). Each entry must be an allowlisted selectable mode (else a
 *    `ValidationError`). When OMITTED entirely, `includedModes` defaults to all
 *    seven selectable modes (include everything). When PRESENT but empty/blank
 *    (an explicit "none selected"), a `ValidationError` is thrown — at least one
 *    transport mode is required (Req 6.4).
 *
 * This function deliberately does NOT reject identical origin/destination —
 * that domain rule (Req 2.5) is enforced by `RouteService.planRoutes`, which is
 * the single source of truth for it and is exercised by Property 6.
 *
 * @param params - the request query parameters
 * @returns the validated {@link RouteRequest}
 * @throws {ValidationError} when any parameter is missing or malformed
 */
export function validateRouteParams(params: QueryParams): RouteRequest {
  const originId = validateLocationId(getParam(params, 'originId'), 'originId');
  const destinationId = validateLocationId(
    getParam(params, 'destinationId'),
    'destinationId',
  );
  const time = validateOptionalIsoTime(getParam(params, 'time'));
  const depArr = validateWhen(getParam(params, 'when'));
  const includedModes = validateModes(getParam(params, 'modes'));

  return { originId, destinationId, time, depArr, includedModes };
}

/**
 * Validate a single required location id against the allowlist pattern.
 *
 * @param value - the raw parameter value (may be undefined)
 * @param field - the parameter name, for error messages
 * @returns the validated id
 * @throws {ValidationError} when missing, empty, or not matching the allowlist
 */
function validateLocationId(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === '') {
    throw new ValidationError(`The "${field}" parameter is required.`);
  }
  if (!LOCATION_ID_PATTERN.test(value)) {
    throw new ValidationError(`The "${field}" parameter is not a valid location id.`);
  }
  return value;
}

/**
 * Validate an OPTIONAL ISO 8601 time value.
 *
 * @param value - the raw parameter value (may be undefined)
 * @returns the validated ISO string, or `''` when absent (meaning "now")
 * @throws {ValidationError} when present but not a valid ISO 8601 date-time
 */
function validateOptionalIsoTime(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    return '';
  }
  if (!ISO_8601_PATTERN.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new ValidationError('The "time" parameter must be a valid ISO 8601 date-time.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// `when` (Time_Filter) and `modes` (Mode_Selection) validation (Req 6, 7)
// ---------------------------------------------------------------------------

/** The allowlisted `when` (Time_Filter) values and their `depArr` mapping. */
const WHEN_TO_DEP_ARR: Record<string, 'dep' | 'arr'> = {
  leaveNow: 'dep',
  leaveAt: 'dep',
  arriveBy: 'arr',
};

/** The seven user-selectable transport modes, in Mode_Selection order. */
const SELECTABLE_MODES: readonly SelectableMode[] = [
  'train',
  'metro',
  'lightRail',
  'bus',
  'coach',
  'ferry',
  'school',
];

/** Lookup set for selectable-mode names (case-sensitive allowlist). */
const SELECTABLE_MODE_SET = new Set<string>(SELECTABLE_MODES);

/**
 * EFA `transportation.product.class` codes accepted in `modes`, mapped to their
 * selectable-mode name. Mirrors the design's transport mode table.
 */
const MODE_CODE_TO_NAME: Record<string, SelectableMode> = {
  '1': 'train',
  '2': 'metro',
  '4': 'lightRail',
  '5': 'bus',
  '7': 'coach',
  '9': 'ferry',
  '11': 'school',
};

/**
 * Validate the OPTIONAL `when` (Time_Filter) parameter and map it to `depArr`.
 *
 * Rules:
 *  - Absent (or blank) → defaults to `leaveNow` → `depArr='dep'`.
 *  - Present → must be one of `leaveNow | leaveAt | arriveBy` (allowlist).
 *    `leaveNow`/`leaveAt` map to `'dep'`; `arriveBy` maps to `'arr'`.
 *
 * @param value - the raw parameter value (may be undefined)
 * @returns the mapped `depArr`
 * @throws {ValidationError} when present but not an allowlisted value
 */
function validateWhen(value: string | undefined): 'dep' | 'arr' {
  if (value === undefined || value.trim() === '') {
    return 'dep';
  }
  const depArr = WHEN_TO_DEP_ARR[value];
  if (depArr === undefined) {
    throw new ValidationError(
      'The "when" parameter must be one of leaveNow, leaveAt, or arriveBy.',
    );
  }
  return depArr;
}

/**
 * Validate the OPTIONAL `modes` (Mode_Selection) parameter into the included
 * selectable modes.
 *
 * Rules (Req 6.1, 6.3, 6.4):
 *  - OMITTED entirely (undefined) → include EVERYTHING (all seven selectable
 *    modes), since "no filter" means no exclusion.
 *  - PRESENT but empty/blank (e.g. `modes=` or only whitespace/commas) → an
 *    explicit "none selected", which is invalid: at least one transport mode is
 *    required.
 *  - Otherwise → a comma-separated list of names (train/metro/lightRail/bus/
 *    coach/ferry/school) and/or numeric codes (1/2/4/5/7/9/11). Each entry must
 *    resolve to an allowlisted selectable mode; duplicates collapse.
 *
 * @param value - the raw parameter value (may be undefined)
 * @returns the included selectable modes (as {@link TransportMode}[])
 * @throws {ValidationError} when explicitly empty or any entry is not allowlisted
 */
function validateModes(value: string | undefined): TransportMode[] {
  // Omitted entirely → include everything (no exclusion).
  if (value === undefined) {
    return [...SELECTABLE_MODES];
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Present but empty/blank → explicit "none selected" (Req 6.4).
  if (entries.length === 0) {
    throw new ValidationError('At least one transport mode is required.');
  }

  const included: TransportMode[] = [];
  for (const entry of entries) {
    const name = MODE_CODE_TO_NAME[entry] ?? entry;
    if (!SELECTABLE_MODE_SET.has(name)) {
      throw new ValidationError(
        `The "modes" parameter contains an unsupported transport mode: "${entry}".`,
      );
    }
    if (!included.includes(name as TransportMode)) {
      included.push(name as TransportMode);
    }
  }

  return included;
}

// ---------------------------------------------------------------------------
// Rate limiting (per-IP + global, fixed window)
// ---------------------------------------------------------------------------

/** Options for {@link createRateLimiter}. */
export interface RateLimiterOptions {
  /** Fixed window width in milliseconds. Must be a positive, finite number. */
  windowMs: number;
  /** Maximum allowed requests per window FOR A SINGLE IP. Positive integer. */
  maxPerWindow: number;
  /**
   * Optional overall ceiling across ALL IPs within a window, protecting the
   * shared upstream TfNSW quota. When omitted, only the per-IP limit applies.
   * Positive integer when provided.
   */
  globalMaxPerWindow?: number;
  /**
   * Injectable time source returning epoch milliseconds (defaults to
   * {@link Date.now}). Provided so tests can advance time deterministically.
   */
  now?: () => number;
}

/** The outcome of a {@link RateLimiter.check} call. */
export interface RateLimitResult {
  /** Whether the request is permitted under both the per-IP and global limits. */
  allowed: boolean;
  /**
   * When `allowed` is false, the number of milliseconds the caller should wait
   * before the limiting window resets (suitable for a `Retry-After` header).
   * Absent when `allowed` is true.
   */
  retryAfterMs?: number;
}

/** A rate limiter instance returned by {@link createRateLimiter}. */
export interface RateLimiter {
  /**
   * Account for a request from `ip` and report whether it is allowed. A blocked
   * request does NOT consume budget (counters are only incremented when the
   * request is allowed), so a client is throttled rather than permanently
   * locked out within a window.
   */
  check(ip: string): RateLimitResult;
}

/** Internal per-key fixed-window counter. */
interface WindowCounter {
  /** Epoch ms at the start of the current window. */
  windowStart: number;
  /** Requests counted in the current window. */
  count: number;
}

/**
 * Create an in-memory, fixed-window rate limiter keyed by client IP, with an
 * optional global ceiling across all IPs.
 *
 * Algorithm (per IP and, when configured, globally):
 *  - Time is divided into fixed windows of `windowMs`. The first request from a
 *    key starts its window; subsequent requests within `windowMs` increment the
 *    same window's counter; once `windowMs` elapses the window resets.
 *  - A request is allowed only when BOTH the per-IP counter and the global
 *    counter are below their respective maxima. Allowed requests increment both
 *    counters; blocked requests increment neither and report `retryAfterMs`
 *    until the most constraining window resets.
 *
 * Memory: stale per-IP counters whose window has fully elapsed are pruned
 * lazily on access, so the key map does not grow unbounded for transient IPs.
 *
 * @param options - window width, per-IP and optional global maxima, and `now`
 * @returns a {@link RateLimiter}
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, maxPerWindow, globalMaxPerWindow } = options;
  const now = options.now ?? Date.now;

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimiter: windowMs must be a positive, finite number');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow <= 0) {
    throw new Error('createRateLimiter: maxPerWindow must be a positive integer');
  }
  if (
    globalMaxPerWindow !== undefined &&
    (!Number.isInteger(globalMaxPerWindow) || globalMaxPerWindow <= 0)
  ) {
    throw new Error('createRateLimiter: globalMaxPerWindow must be a positive integer');
  }

  const perIp = new Map<string, WindowCounter>();
  const globalCounter: WindowCounter = { windowStart: 0, count: 0 };

  /**
   * Return the live counter for `existing`, resetting it to a fresh window when
   * the previous window has fully elapsed (or when there is no prior window).
   */
  function liveCounter(existing: WindowCounter | undefined, current: number): WindowCounter {
    if (existing === undefined || current - existing.windowStart >= windowMs) {
      return { windowStart: current, count: 0 };
    }
    return existing;
  }

  /** Milliseconds until the given window resets. */
  function retryAfter(counter: WindowCounter, current: number): number {
    return Math.max(0, counter.windowStart + windowMs - current);
  }

  /** Drop per-IP counters whose window has fully elapsed (bounded growth). */
  function pruneExpired(current: number): void {
    for (const [key, counter] of perIp) {
      if (current - counter.windowStart >= windowMs) {
        perIp.delete(key);
      }
    }
  }

  return {
    check(ip: string): RateLimitResult {
      const current = now();

      const ipCounter = liveCounter(perIp.get(ip), current);
      const globalLive =
        globalMaxPerWindow === undefined
          ? undefined
          : liveCounter(
              globalCounter.windowStart === 0 && globalCounter.count === 0
                ? undefined
                : globalCounter,
              current,
            );

      const ipBlocked = ipCounter.count >= maxPerWindow;
      const globalBlocked =
        globalMaxPerWindow !== undefined &&
        globalLive !== undefined &&
        globalLive.count >= globalMaxPerWindow;

      if (ipBlocked || globalBlocked) {
        // Persist the (possibly reset) windows so their reset times are stable,
        // but do NOT consume budget for a blocked request.
        perIp.set(ip, ipCounter);
        if (globalLive !== undefined) {
          globalCounter.windowStart = globalLive.windowStart;
          globalCounter.count = globalLive.count;
        }

        const waits: number[] = [];
        if (ipBlocked) {
          waits.push(retryAfter(ipCounter, current));
        }
        if (globalBlocked && globalLive !== undefined) {
          waits.push(retryAfter(globalLive, current));
        }
        return { allowed: false, retryAfterMs: Math.max(...waits) };
      }

      // Allowed: consume one unit of budget from both windows.
      ipCounter.count += 1;
      perIp.set(ip, ipCounter);
      if (globalLive !== undefined) {
        globalLive.count += 1;
        globalCounter.windowStart = globalLive.windowStart;
        globalCounter.count = globalLive.count;
      }

      pruneExpired(current);
      return { allowed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * Parse the comma-separated `ALLOWED_ORIGINS` environment value into a trimmed,
 * non-empty list of origins. Surrounding whitespace and empty entries are
 * dropped. Returns an empty array when the value is absent or blank.
 *
 * @param value - the raw env string (e.g. `"http://localhost:5173,https://x"`)
 * @returns the parsed list of allowed origins
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Compute the CORS response headers for a request, restricting
 * `Access-Control-Allow-Origin` to the configured allowlist.
 *
 * Behaviour:
 *  - When the request `origin` is present AND in `allowedOrigins`, the response
 *    echoes that exact origin and adds `Vary: Origin` (so caches key on it).
 *  - When the origin is missing or not allowed, NO
 *    `Access-Control-Allow-Origin` header is returned (the browser then blocks
 *    the cross-origin read). `Vary: Origin` is still set.
 *  - Allowed methods/headers for the simple GET API are always advertised so
 *    preflight (`OPTIONS`) requests succeed for permitted origins.
 *
 * This is a pure function: it returns headers to set and performs no I/O.
 *
 * @param origin - the request `Origin` header value (may be undefined/null)
 * @param allowedOrigins - the configured allowlist (see {@link parseAllowedOrigins})
 * @returns a map of header name to value to apply to the response
 */
export function corsHeaders(
  origin: string | undefined | null,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (origin !== undefined && origin !== null && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}
