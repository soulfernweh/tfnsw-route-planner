import { describe, it, expect, vi } from 'vitest';

import { TfnswClient, sydneyDateTimeParts } from './client.js';
import type { FetchFn } from './client.js';
import { ServiceUnavailableError } from '../domain/errors.js';

// Unit tests for the secure TfNSW client's error/timeout mapping and key
// handling (task 6.2).
//
// Validates: Requirements 1.5, 2.6
//
// These are EXAMPLE-BASED unit tests (not property tests). They drive the
// client with an injected fake `fetchFn` so no real network I/O occurs, and use
// `retryDelayMs: 0` to keep the single retry instant. The client's documented
// resilience contract is:
//   - transient failures (fetch rejects, or HTTP 5xx) => one retry, then
//     `ServiceUnavailableError`;
//   - permanent failures (HTTP 4xx) => no retry, `ServiceUnavailableError`;
//   - the API key and raw upstream payloads NEVER appear in a thrown error.

const TEST_API_KEY = 'SECRET-TEST-KEY-abc123';
const TEST_BASE_URL = 'https://example.test/v1/tp/';

/** A minimal valid rapidJSON stop_finder body the normaliser accepts. */
const VALID_STOP_FINDER_BODY = {
  locations: [
    { id: '10101100', name: 'Central Station', type: 'station' },
    { id: '10101101', name: 'Town Hall Station', type: 'station' },
  ],
};

/**
 * Build a minimal `Response`-like object exposing only the members the client
 * touches (`ok`, `status`, `json`). Cast through `unknown` to `Response`.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Construct a client wired to an injected fake fetch with instant retries. */
function makeClient(fetchFn: FetchFn): TfnswClient {
  return new TfnswClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    fetchFn,
    retryDelayMs: 0,
  });
}

describe('TfnswClient error/timeout mapping (Requirements 1.5, 2.6)', () => {
  // (a) transient failure => exactly one retry (two calls) then ServiceUnavailableError
  it('retries once on a rejected fetch, then throws ServiceUnavailableError', async () => {
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(() =>
      Promise.reject(new Error('network down')),
    );
    const client = makeClient(fetchFn);

    await expect(client.stopFinder('central')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries once on an HTTP 500, then throws ServiceUnavailableError', async () => {
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(() =>
      Promise.resolve(jsonResponse({ error: 'boom' }, 500)),
    );
    const client = makeClient(fetchFn);

    await expect(client.stopFinder('central')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // (b) success on the retry resolves normally with normalised results
  it('recovers when the retry succeeds and returns normalised locations', async () => {
    const fetchFn = vi
      .fn<Parameters<FetchFn>, ReturnType<FetchFn>>()
      .mockRejectedValueOnce(new Error('transient blip'))
      .mockResolvedValueOnce(jsonResponse(VALID_STOP_FINDER_BODY, 200));
    const client = makeClient(fetchFn);

    const locations = await client.stopFinder('central');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({ id: '10101100', name: 'Central Station' });
  });

  // (c) permanent failure (4xx) => no retry (single call) then ServiceUnavailableError
  it('does not retry on HTTP 400 and throws ServiceUnavailableError', async () => {
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(() =>
      Promise.resolve(jsonResponse({ error: 'bad request' }, 400)),
    );
    const client = makeClient(fetchFn);

    await expect(client.stopFinder('central')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on HTTP 404 and throws ServiceUnavailableError', async () => {
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(() =>
      Promise.resolve(jsonResponse({ error: 'not found' }, 404)),
    );
    const client = makeClient(fetchFn);

    await expect(client.stopFinder('central')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('TfnswClient API key handling (Security: API key protection)', () => {
  // (d) Authorization header is `apikey <key>` and the key never leaks into errors
  it('sends the Authorization header as `apikey <key>`', async () => {
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(() =>
      Promise.resolve(jsonResponse(VALID_STOP_FINDER_BODY, 200)),
    );
    const client = makeClient(fetchFn);

    await client.stopFinder('central');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`apikey ${TEST_API_KEY}`);

    // The query is sent on the URL, with the common rapidJSON params.
    const url = String(fetchFn.mock.calls[0]![0]);
    expect(url).toContain('name_sf=central');
    expect(url).toContain('outputFormat=rapidJSON');
    expect(url).toContain('coordOutputFormat=EPSG');
  });

  it('never includes the API key in a thrown error message', async () => {
    // Force a permanent failure so the client throws.
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(() =>
      Promise.resolve(jsonResponse({ error: 'bad request' }, 400)),
    );
    const client = makeClient(fetchFn);

    let thrown: unknown;
    try {
      await client.stopFinder('central');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(TEST_API_KEY);
    // The full serialised error (incl. stack) must not carry the key either.
    expect(String((thrown as Error).stack ?? '')).not.toContain(TEST_API_KEY);
  });
});

describe('sydneyDateTimeParts (Sydney-local itdDate/itdTime)', () => {
  // (e) Known UTC instants map to the expected Sydney-local values, with the
  // AEST (UTC+10) -> AEDT (UTC+11) daylight-saving offset shift visible.
  it('maps a winter UTC instant to AEST (UTC+10)', () => {
    // 2023-07-01T00:00:00Z is mid-winter in Sydney: AEST, UTC+10 => 10:00 local.
    const { itdDate, itdTime } = sydneyDateTimeParts(
      new Date('2023-07-01T00:00:00Z'),
    );
    expect(itdDate).toBe('20230701');
    expect(itdTime).toBe('1000');
  });

  it('maps a summer UTC instant to AEDT (UTC+11), showing the DST shift', () => {
    // 2024-01-01T00:00:00Z is mid-summer in Sydney: AEDT, UTC+11 => 11:00 local.
    const { itdDate, itdTime } = sydneyDateTimeParts(
      new Date('2024-01-01T00:00:00Z'),
    );
    expect(itdDate).toBe('20240101');
    expect(itdTime).toBe('1100');
  });
});

describe('TfnswClient timeout mapping (Requirements 1.5, 2.6)', () => {
  // (f) A request that never resolves before the abort maps to
  // ServiceUnavailableError; the timeout is transient so it retries once.
  it('maps an aborted/timed-out request to ServiceUnavailableError', async () => {
    const fetchFn = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        }),
    );

    // Tiny timeout so the AbortController fires almost immediately.
    const client = new TfnswClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      fetchFn,
      retryDelayMs: 0,
      stopFinderTimeoutMs: 5,
    });

    await expect(client.stopFinder('central')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    // Timeout is transient: initial attempt + one retry.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
