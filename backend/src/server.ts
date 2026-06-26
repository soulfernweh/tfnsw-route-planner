// Backend composition root + HTTP server bootstrap (task 9.2).
//
// This is the single place that builds the dependency graph and starts the
// process. It reads ALL configuration from the environment (the TfNSW API key
// is read here/by the client ONLY and never logged or returned), constructs the
// caches, services, and rate limiter, wires them into the REST request listener
// from `routes.ts`, and starts a server using Node's built-in `http` module —
// no Express or other HTTP framework is required for two GET endpoints.
//
// Dependency graph (design "Architecture"):
//
//   env ─▶ TfnswClient ─┬─▶ DefaultLocationService ─┐
//                       │      (+ stop-finder cache) │
//                       └─▶ RouteService ────────────┤─▶ REST listener ─▶ http.Server
//                              (+ trip cache)         │
//                  createRateLimiter ─────────────────┘
//
// SECURITY (design "Security"): the endpoints are intentionally unauthenticated
// (no user accounts); they are protected by validation + per-IP/global rate
// limiting + CORS restricted to ALLOWED_ORIGINS, as documented in `routes.ts`.
// The API key lives only in the backend env and is injected by `TfnswClient`.
//
// Design reference: .kiro/specs/tfnsw-route-planner/design.md
//   ("Architecture", "Caching Strategy", "Security"). Requirements: 1.1, 2.2,
//   3.2, 4.2, 5.5, 3.4.

import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

import type { Journey, Location } from './domain/models.js';
import { TfnswClient } from './tfnsw/client.js';
import { TtlLruCache } from './infra/cache.js';
import { DefaultLocationService } from './services/locationService.js';
import { RouteService } from './services/routeService.js';
import { createRateLimiter, parseAllowedOrigins } from './api/middleware.js';
import { createNodeRequestListener, type RouteHandlerDeps } from './api/routes.js';

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

/** Default port when `PORT` is unset/invalid. */
const DEFAULT_PORT = 8787;

/** Stop-finder result cache capacity (diverse but repeating queries). */
const STOP_FINDER_CACHE_MAX_SIZE = 500;
/** Trip result cache capacity (short-lived entries, bounded growth). */
const TRIP_CACHE_MAX_SIZE = 500;

/** Rate-limiter defaults (fixed window). Overridable via env. */
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX_PER_IP = 60;
const DEFAULT_RATE_GLOBAL_MAX = 600;

/** Resolved, validated server configuration. */
export interface ServerConfig {
  port: number;
  allowedOrigins: string[];
  rateWindowMs: number;
  rateMaxPerIp: number;
  rateGlobalMax: number;
}

/**
 * Read and validate server configuration from `process.env`, applying sensible
 * defaults. The TfNSW API key/base URL are intentionally NOT surfaced here —
 * they are read directly (and only) by {@link TfnswClient}.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: parsePositiveInt(env['PORT'], DEFAULT_PORT),
    allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS']),
    rateWindowMs: parsePositiveInt(env['RATE_LIMIT_WINDOW_MS'], DEFAULT_RATE_WINDOW_MS),
    rateMaxPerIp: parsePositiveInt(env['RATE_LIMIT_MAX_PER_IP'], DEFAULT_RATE_MAX_PER_IP),
    rateGlobalMax: parsePositiveInt(env['RATE_LIMIT_GLOBAL_MAX'], DEFAULT_RATE_GLOBAL_MAX),
  };
}

/** Parse a positive integer from an env string, falling back to `fallback`. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

/**
 * Build the wired backend dependency graph from configuration. The `TfnswClient`
 * reads `TFNSW_API_KEY`/`TFNSW_BASE_URL` from the environment itself.
 */
export function buildDependencies(config: ServerConfig): RouteHandlerDeps {
  const client = new TfnswClient();

  const stopFinderCache = new TtlLruCache<Location[]>({ maxSize: STOP_FINDER_CACHE_MAX_SIZE });
  const tripCache = new TtlLruCache<Journey[]>({ maxSize: TRIP_CACHE_MAX_SIZE });

  const locationService = new DefaultLocationService(client, stopFinderCache);
  const routeService = new RouteService(client, { cache: tripCache });

  const rateLimiter = createRateLimiter({
    windowMs: config.rateWindowMs,
    maxPerWindow: config.rateMaxPerIp,
    globalMaxPerWindow: config.rateGlobalMax,
  });

  return {
    locationService,
    routeService,
    rateLimiter,
    allowedOrigins: config.allowedOrigins,
  };
}

/**
 * Build (but do not start) the HTTP server with the full dependency graph
 * wired. Exposed separately from {@link startServer} so tests can drive it
 * against an ephemeral port.
 */
export function buildServer(config: ServerConfig = loadConfig()): Server {
  const deps = buildDependencies(config);
  return createServer(createNodeRequestListener(deps));
}

/**
 * Build and start the HTTP server, listening on the configured port.
 */
export function startServer(config: ServerConfig = loadConfig()): Server {
  const server = buildServer(config);
  server.listen(config.port, () => {
    // Log only non-sensitive runtime info — never the API key.
    // eslint-disable-next-line no-console
    console.log(
      `TfNSW Route Planner backend listening on port ${String(config.port)} ` +
        `(allowed origins: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'none'})`,
    );
  });
  return server;
}

// Start automatically when run as the entrypoint (e.g. `tsx src/server.ts`).
// Guarded so importing this module (in tests) does not start a listener. The
// comparison resolves both sides to absolute OS paths so it works on Windows
// and POSIX alike.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (invokedDirectly) {
  startServer();
}
