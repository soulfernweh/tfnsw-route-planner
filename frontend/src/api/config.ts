// Runtime configuration for the API client.
//
// The backend base URL is configurable so the SPA can target a local dev
// backend, a staging proxy, or production without code changes. It is read
// from a Vite environment variable (`VITE_API_BASE_URL`), falling back to a
// relative `/api`-friendly default suitable for same-origin deployment behind
// a reverse proxy.

/**
 * Base URL the API client prefixes onto every request path.
 *
 * - In development, set `VITE_API_BASE_URL` (e.g. `http://localhost:8080`).
 * - In production behind a reverse proxy on the same origin, leave it unset
 *   and requests resolve relative to the current origin.
 *
 * A trailing slash, if present, is stripped so paths can be joined cleanly.
 */
export function getApiBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  const raw = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : '';
  return raw.replace(/\/+$/, '');
}
