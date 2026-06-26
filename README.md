# TfNSW Route Planner

A route-planning web app built on the [Transport for NSW Trip Planner API](https://opendata.transport.nsw.gov.au/). Search for stops and stations, find routes between two points, and compare the **fastest** and **most economical** options side by side.

> Fares are **estimates**. The Trip Planner API does not return Opal fares, so the app computes them from per-leg distance and mode using configurable Opal distance bands. See [Known limitations](#known-limitations).

## Architecture

Two-tier monorepo, mobile-first, designed so a future native Android app can reuse the same backend:

```
shared/    @tfnsw/shared    Pure formatters (AUD, duration) used by both tiers
backend/   @tfnsw/backend   Stateless service layer + REST API (the only holder of the API key)
frontend/  @tfnsw/frontend  Mobile-first React + Vite SPA
```

- **Backend** owns all TfNSW integration: a secure API client, an EFA-response normaliser, the Opal fare calculator, the route ranking/comparison engine, caching, and a small HTTP REST API. The TfNSW API key never leaves the backend.
- **Frontend** is a thin presentation client that talks to the backend over HTTP and knows only the API contract.

### REST API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/locations?query=` | Location autocomplete (min 3 chars) |
| `GET` | `/api/routes?originId=&destinationId=&time=` | Route discovery + ranking + comparison, with full leg-by-leg detail |

Both endpoints are unauthenticated (no user accounts) and protected by input validation, per-IP + global rate limiting, and CORS restricted to `ALLOWED_ORIGINS`.

## Prerequisites

- **Node.js 20.6+** (developed on Node 24)
- A free **TfNSW Open Data API key**: register at the [TfNSW Open Data Hub](https://opendata.transport.nsw.gov.au/), create an Application, and enable at least the **Trip Planner** API product.

## Setup

```bash
npm install
```

Create a local `.env` at the repo root (it is gitignored — never commit it). Copy `.env.example` and fill in your key:

```dotenv
TFNSW_API_KEY=your-key-here
TFNSW_BASE_URL=https://api.transport.nsw.gov.au/v1/tp/
ALLOWED_ORIGINS=http://localhost:5173
```

## Running locally

Start the backend API (defaults to port `8787`):

```bash
node --env-file=.env --import tsx backend/src/server.ts
# or, from backend/, with the env already loaded into your shell:
npm run dev --workspace @tfnsw/backend
```

> `node --env-file` will **not** override a variable already set in your shell. If the key looks wrong, open a fresh terminal so no stale `TFNSW_API_KEY` shadows the file.

Start the frontend (Vite dev server on port `5173`):

```bash
npm run dev --workspace @tfnsw/frontend
```

The frontend calls the backend at the same origin by default; set `VITE_API_BASE_URL` if the backend runs elsewhere.

## Live smoke test

A manual, opt-in script hits the **real** TfNSW API end to end (Stop Finder → Trip → fares → ranking) to confirm your key and the field mappings work. It reads the key directly from `.env`:

```bash
npm run smoke --workspace @tfnsw/backend
```

Override the queries with `SMOKE_ORIGIN` / `SMOKE_DESTINATION`. The script never prints your API key.

## Testing

```bash
npm test          # full suite (unit, property-based, integration)
npm run typecheck # strict TypeScript across all packages
npm run build     # compile backend + build the frontend bundle
```

The suite includes property-based tests (via [`fast-check`](https://github.com/dubzzz/fast-check), ≥100 runs each) for the pure logic — ranking, fare aggregation, comparison maths, formatters, and EFA normalisation — plus example, edge-case, and integration tests.

## Known limitations

- **Fares are estimates.** The Trip Planner API returns no Opal fare data. The backend estimates fares from per-leg distance and mode using the distance bands in `backend/src/fares/data/opalFares.json`. Reconcile those values against the official [Opal Fares dataset](https://opendata.transport.nsw.gov.au/data/dataset/opal-fares) before relying on them.
- **Distance source.** The live trip response omits `leg.distance`, so distance is derived from the leg's `coords` polyline (haversine). This is an approximation of the travelled path.
- **Out of scope (for now):** transfer discounts, daily/weekly fare caps, and the rail station-to-station track-distance matrix.

## Security

- The TfNSW API key is read from the backend environment only and is never sent to clients, embedded in the frontend bundle, logged, or included in error responses.
- `.env` is gitignored. If a key is ever exposed (e.g. pasted into a chat or commit), rotate it in the TfNSW Open Data Hub.

## Project layout

```
backend/src/
  domain/      models, errors, journey math, ranking & comparison engine
  tfnsw/       EFA normaliser, secure API client
  fares/       Opal fare calculator + distance-band data
  infra/       in-memory TTL + LRU cache
  services/    location & route services
  api/         validation/rate-limit/CORS middleware, REST routes
  scripts/     live smoke test
  server.ts    composition root + HTTP server
frontend/src/
  api/         typed backend client + contract types
  components/  search field, route list, comparison view, journey detail
  App.tsx      end-to-end wiring
shared/src/    formatters shared by both tiers
.kiro/specs/tfnsw-route-planner/   requirements, design, and task spec
```

## License

See repository terms. TfNSW data is provided under the [Transport for NSW Open Data licence](https://opendata.transport.nsw.gov.au/data-licence).
