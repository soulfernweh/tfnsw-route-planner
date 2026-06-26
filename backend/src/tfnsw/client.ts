// Secure TfNSW (Transport for NSW) Trip Planner API client.
//
// This is the ONLY component that performs network I/O against the upstream EFA
// (Elektronische Fahrplanauskunft) endpoints. It owns three concerns:
//
//   1. SECURE KEY INJECTION — the API key is read from the backend environment
//      ONLY (`TFNSW_API_KEY`) and injected into the `Authorization: apikey
//      <key>` header. The key (and any raw upstream payload) is NEVER logged,
//      and NEVER included in a thrown error. Upstream failures surface as a
//      generic `ServiceUnavailableError`.
//   2. RESILIENCE — every request is bounded by an AbortController timeout
//      (stop_finder ~3s, trip ~5s) and gets a single short retry with backoff
//      on transient failures (network error / timeout / HTTP 5xx). Exhausted
//      retries, timeouts, and non-OK responses all map to
//      `ServiceUnavailableError` so no upstream detail leaks.
//   3. NORMALISATION HAND-OFF — successful responses are parsed as JSON and
//      delegated to the EFA normaliser (`normaliseLocations` /
//      `normaliseJourneys`), so callers only ever see clean domain models.
//
// Design reference: .kiro/specs/tfnsw-route-planner/design.md
//   ("Components and Interfaces" → TfnswClient, "TfNSW Client Request Details",
//    "Error Handling", "Security" → API key protection).
//
// Requirements: 1.1, 1.5, 2.2, 2.6, Security "API key protection".

import type { Journey, Location, TfnswClient as ITfnswClient } from '../domain/models.js';
import { ServiceUnavailableError } from '../domain/errors.js';
import { normaliseJourneys, normaliseLocations } from './normalise.js';

/**
 * The `fetch` implementation used by the client. Defaults to the Node 18+
 * global `fetch`, but can be injected in tests to avoid real network I/O.
 */
export type FetchFn = typeof fetch;

/** Departure (`dep`) vs arrival (`arr`) trip macro. */
export type DepArrMode = 'dep' | 'arr';

/** Default upstream base URL (note the trailing slash — paths are relative). */
const DEFAULT_BASE_URL = 'https://api.transport.nsw.gov.au/v1/tp/';

/** Per-request timeout budgets (design: search ≤ 3s, route ≤ 5s). */
const DEFAULT_STOP_FINDER_TIMEOUT_MS = 3_000;
const DEFAULT_TRIP_TIMEOUT_MS = 5_000;

/** Backoff delay before the single retry of a transient failure. */
const DEFAULT_RETRY_DELAY_MS = 200;

/** Max locations the stop finder should return (mirrors the normaliser cap). */
const ANY_MAX_SIZE_HIT_LIST = 10;

/**
 * Construction-time options. All are optional; sensible production defaults are
 * derived from the environment + the Node global `fetch`. Tests can inject a
 * fake `fetchFn`, an explicit `apiKey`/`baseUrl`, and zeroed delays/timeouts to
 * stay deterministic and fast.
 */
export interface TfnswClientOptions {
  /** Upstream base URL. Default: `TFNSW_BASE_URL` env, else the public URL. */
  baseUrl?: string;
  /** API key. Default: `TFNSW_API_KEY` env. Read from env ONLY in production. */
  apiKey?: string;
  /** Injectable `fetch`. Default: `globalThis.fetch`. */
  fetchFn?: FetchFn;
  /** stop_finder timeout in ms. Default 3000. */
  stopFinderTimeoutMs?: number;
  /** trip timeout in ms. Default 5000. */
  tripTimeoutMs?: number;
  /** Backoff before the single retry, in ms. Default 200. */
  retryDelayMs?: number;
}

/**
 * Internal marker used to distinguish a transient (retryable) failure — a
 * network error, an aborted/timed-out request, or an HTTP 5xx — from a
 * permanent one. It carries NO upstream detail beyond a short reason and is
 * never surfaced to callers (it is always converted to `ServiceUnavailableError`).
 */
class TransientUpstreamError extends Error {}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Zero-pad a number to two digits (for HH/MM/MM/DD components). */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Secure, resilient TfNSW Trip Planner client.
 *
 * Implements the {@link ITfnswClient} contract: `stopFinder` for location
 * autocomplete and `trip` for journey planning, each returning normalised
 * domain models.
 */
export class TfnswClient implements ITfnswClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly stopFinderTimeoutMs: number;
  private readonly tripTimeoutMs: number;
  private readonly retryDelayMs: number;

  public constructor(options: TfnswClientOptions = {}) {
    // Base URL: explicit option > env > public default. A trailing slash is
    // enforced so relative endpoint paths resolve under `/v1/tp/`.
    const rawBaseUrl =
      options.baseUrl ?? process.env['TFNSW_BASE_URL'] ?? DEFAULT_BASE_URL;
    this.baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;

    // API key: explicit option (tests) > env. NEVER logged or echoed anywhere.
    this.apiKey = options.apiKey ?? process.env['TFNSW_API_KEY'] ?? '';

    // Default to the Node 18+ global fetch; bind to preserve `this`.
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

    this.stopFinderTimeoutMs =
      options.stopFinderTimeoutMs ?? DEFAULT_STOP_FINDER_TIMEOUT_MS;
    this.tripTimeoutMs = options.tripTimeoutMs ?? DEFAULT_TRIP_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /**
   * Autocomplete locations for a free-text query.
   *
   * Calls the `stop_finder` endpoint and returns up to 10 normalised
   * `Location`s. Throws `ServiceUnavailableError` on any upstream failure.
   */
  public async stopFinder(query: string): Promise<Location[]> {
    const params = new URLSearchParams({
      type_sf: 'any',
      name_sf: query,
      TfNSWSF: 'true',
      anyMaxSizeHitList: String(ANY_MAX_SIZE_HIT_LIST),
      odvSugMacro: '1',
    });

    const payload = await this.requestJson(
      'stop_finder',
      params,
      this.stopFinderTimeoutMs,
    );
    return normaliseLocations(payload);
  }

  /**
   * Plan journeys between two stop ids at a given time.
   *
   * Calls the `trip` endpoint and returns the normalised `Journey[]` (capped at
   * 5, ordered by departure). `time` is interpreted in Australia/Sydney local
   * time for the upstream `itdDate`/`itdTime` params. `mode` selects whether the
   * time is a desired departure (`dep`, default) or arrival (`arr`). Throws
   * `ServiceUnavailableError` on any upstream failure.
   */
  public async trip(
    originId: string,
    destinationId: string,
    time: Date,
    mode: DepArrMode = 'dep',
  ): Promise<Journey[]> {
    const { itdDate, itdTime } = sydneyDateTimeParts(time);

    const params = new URLSearchParams({
      type_origin: 'stop',
      name_origin: originId,
      type_destination: 'stop',
      name_destination: destinationId,
      depArrMacro: mode,
      itdDate,
      itdTime,
      TfNSWTR: 'true',
    });

    const payload = await this.requestJson('trip', params, this.tripTimeoutMs);
    return normaliseJourneys(payload);
  }

  /**
   * Perform a GET request to `<baseUrl><path>` with the common params merged in,
   * applying a per-request timeout and a single retry with backoff on transient
   * failures. Returns the parsed JSON body (typed `unknown` — the normaliser is
   * responsible for validating the untrusted shape).
   *
   * On exhausted retries, timeout, non-OK response, or unparseable body, throws
   * a generic `ServiceUnavailableError`. The API key and the raw upstream body
   * are NEVER included in the thrown error.
   */
  private async requestJson(
    path: string,
    params: URLSearchParams,
    timeoutMs: number,
  ): Promise<unknown> {
    const url = this.buildUrl(path, params);

    // initial attempt + one retry.
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.attemptJson(url, timeoutMs);
      } catch (error) {
        const isTransient = error instanceof TransientUpstreamError;
        const hasRetryLeft = attempt < maxAttempts;
        if (isTransient && hasRetryLeft) {
          await delay(this.retryDelayMs);
          continue;
        }
        // Permanent failure, or transient with no retries left: surface a
        // generic error. Deliberately drop the original cause so no upstream
        // payload / key / stack can leak through the error chain.
        throw new ServiceUnavailableError();
      }
    }

    // Unreachable (the loop always returns or throws), but keeps the type checker
    // satisfied and guards against accidental fallthrough.
    throw new ServiceUnavailableError();
  }

  /**
   * A single request attempt. Resolves with the parsed JSON body, throws
   * {@link TransientUpstreamError} for retryable failures (network/abort/5xx)
   * and a plain `Error` for permanent ones (4xx / unparseable body).
   */
  private async attemptJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          // SECURITY: the only place the key is used. Never logged/returned.
          Authorization: `apikey ${this.apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch {
      // Network error or an abort (timeout) — both are transient. We swallow
      // the original error so nothing about the request can leak.
      throw new TransientUpstreamError('upstream request failed');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 5xx is transient (worth a retry); other non-OK statuses are permanent.
      if (response.status >= 500) {
        throw new TransientUpstreamError('upstream 5xx');
      }
      throw new Error('upstream non-OK');
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      // A malformed body is a permanent upstream problem, not worth retrying.
      throw new Error('upstream returned an unparseable body');
    }
  }

  /** Build the fully-qualified request URL with common + endpoint params. */
  private buildUrl(path: string, params: URLSearchParams): string {
    const url = new URL(path, this.baseUrl);
    // Common params required on every request.
    url.searchParams.set('outputFormat', 'rapidJSON');
    url.searchParams.set('coordOutputFormat', 'EPSG:4326');
    // Endpoint-specific params.
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

/**
 * Compute the Australia/Sydney-local `itdDate` (YYYYMMDD) and `itdTime` (HHMM)
 * for a given instant.
 *
 * Uses `Intl.DateTimeFormat` with `timeZone: 'Australia/Sydney'` so the result
 * is deterministic and independent of the host machine's local timezone (the
 * DST offset is handled by the runtime's IANA tz database). Exported for direct
 * unit testing.
 */
export function sydneyDateTimeParts(time: Date): {
  itdDate: string;
  itdTime: string;
} {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(time);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  // `h23` keeps hours in 00-23; guard the rare '24' some engines emit at midnight.
  const rawHour = lookup('hour');
  const hour = pad2(Number(rawHour) % 24);
  const minute = lookup('minute');

  return {
    itdDate: `${year}${month}${day}`,
    itdTime: `${hour}${minute}`,
  };
}
