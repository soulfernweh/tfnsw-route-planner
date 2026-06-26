// Typed API client for the TfNSW Route Planner backend.
//
// This client knows only the API CONTRACT defined in the design document
// (see "REST API Endpoints"), not the backend implementation:
//   GET /api/locations?query=
//   GET /api/routes?originId=&destinationId=&time=
//
// The TfNSW API has no journey id and no per-journey detail endpoint, so there
// is no journey-lookup method here: the `/api/routes` response already carries
// complete leg-by-leg detail for every journey, which the JourneyDetailView
// renders directly.
//
// All responses are typed against the local contract types in `./types`.
// Failures are surfaced as a typed `ApiError` carrying the backend's error
// envelope code/message where available.

import { getApiBaseUrl } from './config';
import type { ApiErrorEnvelope, Location, RouteResult } from './types';

/**
 * Error thrown by the API client for any non-successful response or transport
 * failure. `code` mirrors the backend error envelope code where available
 * (e.g. `VALIDATION_ERROR`, `SERVICE_UNAVAILABLE`), otherwise a synthetic
 * client-side code.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Options accepted when constructing an {@link ApiClient}. */
export interface ApiClientOptions {
  /** Override the base URL; defaults to {@link getApiBaseUrl}. */
  baseUrl?: string;
  /** Override the fetch implementation (useful for tests). */
  fetchFn?: typeof fetch;
}

/** Parameters for a route-planning request. */
export interface PlanRoutesParams {
  originId: string;
  destinationId: string;
  /** ISO 8601 desired departure time. Optional; backend defaults to "now". */
  time?: string;
}

/**
 * Typed client over the backend REST API. Construct once and reuse; it holds
 * no per-request state.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getApiBaseUrl();
    // Bind to preserve `this` when a global fetch is used.
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Location autocomplete (Requirement 1).
   * `GET /api/locations?query={query}`
   */
  async searchLocations(
    query: string,
    signal?: AbortSignal,
  ): Promise<Location[]> {
    const path = `/api/locations?query=${encodeURIComponent(query)}`;
    return this.request<Location[]>(path, signal);
  }

  /**
   * Route discovery + ranking + comparison (Requirements 2-5).
   * `GET /api/routes?originId={o}&destinationId={d}&time={iso}`
   */
  async planRoutes(
    params: PlanRoutesParams,
    signal?: AbortSignal,
  ): Promise<RouteResult> {
    const search = new URLSearchParams({
      originId: params.originId,
      destinationId: params.destinationId,
    });
    if (params.time !== undefined) {
      search.set('time', params.time);
    }
    return this.request<RouteResult>(`/api/routes?${search.toString()}`, signal);
  }

  /**
   * Performs a GET request and decodes a JSON body, translating non-OK
   * responses and transport failures into a typed {@link ApiError}.
   */
  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      // Network failure, DNS error, CORS rejection, or aborted request.
      const message =
        cause instanceof Error ? cause.message : 'Network request failed';
      throw new ApiError('NETWORK_ERROR', message, 0);
    }

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(
        'INVALID_RESPONSE',
        'The server returned an unreadable response.',
        response.status,
      );
    }
  }

  /** Builds an {@link ApiError} from a non-OK response, using the envelope. */
  private async toApiError(response: Response): Promise<ApiError> {
    let code = 'HTTP_ERROR';
    let message = `Request failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as Partial<ApiErrorEnvelope>;
      if (body.error?.code) {
        code = body.error.code;
      }
      if (body.error?.message) {
        message = body.error.message;
      }
    } catch {
      // Non-JSON error body; keep the synthetic defaults above.
    }
    return new ApiError(code, message, response.status);
  }
}

/** A shared default client targeting the configured base URL. */
export const apiClient = new ApiClient();
