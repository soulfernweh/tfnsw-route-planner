# Implementation Plan: TfNSW Route Planner

## Overview

This plan builds the TfNSW Route Planner incrementally in TypeScript, following the two-tier design: a stateless backend service layer that owns all TfNSW integration, normalisation, ranking, and comparison logic, plus a mobile-first web SPA that consumes the backend API.

The build order moves from the inside out: shared domain types and pure helpers first (formatting, ranking, comparison), then the EFA normaliser and secure TfNSW client, then the services and REST endpoints with caching/rate-limiting/validation, and finally the web frontend. Property-based tests are placed next to the pure logic they validate so correctness regressions surface as early as possible. Each step builds on prior steps and ends by wiring components together, leaving no orphaned code.

The backend track (tasks 2–9) and the frontend track (task 11) run in parallel: the frontend communicates with the backend over HTTP and depends only on the API contract defined in the design, not on the backend implementation. Both tracks start immediately after the project setup (task 1.1) and converge only at task 12 (final integration and wiring) and task 13 (final checkpoint). The single genuine cross-track dependency is the shared formatting helpers in `shared/src/format.ts` (task 2.1), which the frontend's `RouteComparisonView` (task 11.8) imports; this is resolved by placing the formatters in a shared monorepo package that both tiers consume.

All property tests use a mature PBT library (`fast-check`), run a minimum of 100 iterations, and are tagged `Feature: tfnsw-route-planner, Property {N}: {text}`.

## Tasks

- [x] 1. Set up monorepo project structure and shared domain types
  - [x] 1.1 Initialise backend, frontend, and shared workspaces with tooling
    - Create a workspace with `backend/`, `frontend/`, and `shared/` packages (TypeScript, package manager workspaces); the `shared/` package holds code imported by both backend and frontend (e.g. formatting helpers)
    - Configure TypeScript (strict mode), linting, and a test runner (e.g. Vitest/Jest) across the packages
    - Add `fast-check` as a dev dependency for property-based testing
    - Create a gitignored `.env` file and an `.env.example` documenting `TFNSW_API_KEY`, `TFNSW_BASE_URL`, and `ALLOWED_ORIGINS`; add `.env` to `.gitignore`
    - _Requirements: Design "Architecture", Security "API key protection"_

  - [x] 1.2 Define shared domain model types
    - Create `backend/src/domain/models.ts` with `Location`, `LocationType`, `TransportMode`, `Leg`, `LegStop`, `Fare`, `Journey`, `RouteRequest`, `RouteResult`, `RouteComparison`, `ComparisonEntry`
    - Encode money as integer cents (`Fare.amountCents`, `currency: 'AUD'`) per the data model
    - Export the service interfaces `LocationService`, `RouteService`, `RouteRankingEngine`, `TfnswClient`
    - _Requirements: 1.2, 2.3, 4.1, 5.2, 5.3_

  - [x] 1.3 Define typed error classes and error envelope
    - Create `backend/src/domain/errors.ts` with `ValidationError` (400), `ServiceUnavailableError` (502/503), `NotFoundError` (404)
    - Add a helper that maps a typed error to the `{ "error": { "code", "message" } }` JSON envelope, ensuring no API key or raw upstream payload is ever included
    - _Requirements: 1.5, 2.5, 2.6, 3.4_

  - [x] 1.4 Extend domain models for verified EFA schema (follow-up to 1.2)
    - In `backend/src/domain/models.ts`, add `distanceMetres: number | null` to `Leg` (EFA `leg.distance` in metres, used for fare estimation)
    - Add `bicycle` to the `TransportMode` union (EFA `transportation.product.class` 101)
    - Document `Journey.id` as a backend-assigned SYNTHETIC id (hash/index of the journey), NOT supplied by TfNSW — the trip API has no journey id
    - _Requirements: 1.2, 2.3, 4.3, 4.5_

- [x] 2. Implement presentation/formatting helpers
  - [x] 2.1 Implement AUD and duration formatters in the shared package
    - Create `shared/src/format.ts` with `formatAud(cents)` (exactly two decimals, value equals cents/100) and `formatDuration(minutes)` (hours + minutes)
    - Place these in the `shared/` package so both the backend and the frontend import them (the frontend's `RouteComparisonView` reuses them); keep them pure and runnable at the presentation boundary
    - _Requirements: 5.2_

  - [x]* 2.2 Write property test for formatting helpers
    - Test `shared/src/format.ts` from the shared package
    - **Property 11: Formatting helpers are exact and reversible**
    - **Validates: Requirements 5.2**

- [x] 3. Implement the Route Ranking & Comparison Engine (pure functions)
  - [x] 3.1 Implement fare aggregation and travel-time/transfer derivation helpers
    - Create `backend/src/domain/journeyMath.ts` with helpers to sum per-leg fares into `totalFare` (null if any fare-bearing leg lacks fare), compute `travelTimeMinutes` (last arrival minus first departure), and derive `transferCount`
    - _Requirements: 2.3, 3.3, 4.2, 4.4_

  - [x]* 3.2 Write property test for travel time computation
    - **Property 5: Travel time equals arrival minus departure including transfer waits**
    - **Validates: Requirements 2.3, 3.3**

  - [x]* 3.3 Write property test for fare aggregation
    - **Property 8: Total fare equals the sum of leg fares**
    - **Validates: Requirements 4.2**

  - [x] 3.4 Implement `selectFastest` and `selectEconomical`
    - Create `backend/src/domain/rankingEngine.ts` implementing `selectFastest` (min travel time, tiebreak fewest transfers) and `selectEconomical` (min fare among priced journeys, tiebreak shortest travel time, excludes null-fare journeys)
    - _Requirements: 3.1, 4.1, 4.4_

  - [x]* 3.5 Write property test for fastest selection
    - **Property 7: Fastest selection minimises travel time then transfers**
    - **Validates: Requirements 3.1**

  - [x]* 3.6 Write property test for economical selection
    - **Property 9: Economical selection minimises fare among priced routes and excludes unpriced routes**
    - **Validates: Requirements 4.1, 4.4**

  - [x] 3.7 Implement `buildComparison`
    - Add `buildComparison(fastest, economical)` to `rankingEngine.ts` computing `travelTimeDifferenceMinutes`, `fareDifferenceCents` (null when either fare missing), `fasterRouteId`/`cheaperRouteId`, `sameRoute`, and `fareUnavailableForFastest`
    - _Requirements: 5.3, 5.4, 5.6_

  - [x]* 3.8 Write property test for comparison differences and labels
    - **Property 10: Comparison differences and faster/cheaper labels are consistent**
    - **Validates: Requirements 5.3**

  - [x]* 3.9 Write property test for coinciding fastest/economical route
    - **Property 12: Coinciding fastest and economical collapse to a single route**
    - **Validates: Requirements 5.4**

  - [x]* 3.10 Write property test for missing fare on the fastest route
    - **Property 13: Missing fare on the fastest route is handled in comparison**
    - **Validates: Requirements 5.6**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the EFA normaliser
  - [x] 5.1 Implement location normalisation
    - Create `backend/src/tfnsw/normalise.ts` with `normaliseLocations(efa)` that maps EFA stop-finder entries to `Location[]`, coerces/validates fields (non-empty name, valid `LocationType`), and caps the list at 10
    - Treat EFA input as untrusted: validate and coerce rather than trust structure
    - _Requirements: 1.1, 1.2_

  - [x]* 5.2 Write property test for location result cap
    - **Property 1: Location results are capped at 10**
    - **Validates: Requirements 1.1**

  - [x]* 5.3 Write property test for normalised location completeness
    - **Property 2: Normalised locations are complete**
    - **Validates: Requirements 1.2**

  - [x] 5.4 Implement journey normalisation
    - Add `normaliseJourneys(efa)` mapping EFA `journeys`/`legs` to `Journey[]` with `Leg`, `LegStop`, computed `travelTimeMinutes`, `transferCount`, `modes`, and `totalFare`; cap at 5 and order by `departureTime`
    - Read leg times from the STOPS (not the leg): `origin.departureTimePlanned` / `origin.departureTimeEstimated` and `destination.arrivalTimePlanned` / `destination.arrivalTimeEstimated`, preferring the estimated value when present, else planned
    - Use `leg.duration` (seconds) for `durationMinutes` and `leg.distance` (metres) for `distanceMetres`
    - Derive `mode` from `transportation.product.class` (1 train, 2 metro, 4 lightRail, 5 bus, 7 coach, 9 ferry, 11 school, 99/100 walk, 101 bicycle)
    - Derive `LegStop.platform` from the stop's `disassembledName` / `name` where available; may be `null`
    - Populate each priced leg's `fare` by calling the Opal Fare Calculator (task 5.7) with the leg's `distanceMetres` and `mode`; walk/bicycle legs are unpriced
    - Assign each journey a backend-assigned SYNTHETIC `id` (TfNSW supplies none)
    - Reuse `journeyMath.ts` helpers for fare/time/transfer derivation
    - Depends on tasks 1.4 (extended models) and 5.7 (Opal Fare Calculator)
    - _Requirements: 2.2, 2.3, 4.2, 4.3, 4.5_

  - [x]* 5.5 Write property test for journey cap and ordering
    - **Property 4: Journeys are capped at 5 and ordered by departure**
    - **Validates: Requirements 2.2**

  - [x]* 5.6 Write property test for EFA normalisation round-trip
    - **Property 14: EFA normalisation round-trip**
    - **Validates: Requirements 1.2, 2.3, 4.3**

  - [x] 5.7 Implement the Opal Fare Calculator
    - Create `backend/src/fares/opalFareCalculator.ts` exposing `estimateLegFare(distanceMetres, mode): Fare | null` per the design's `OpalFareCalculator` interface
    - Map the leg distance to a distance band per mode and each band to a fare value (rail treated approximately); return `null` for walk/bicycle or when no band matches
    - Load the Opal distance-band and fare-value tables as data/config (e.g. JSON under `backend/src/fares/data/`), NOT hard-coded in logic, so they can be updated when Opal pricing changes
    - Computed fares are ESTIMATES (adult Opal); transfer discounts and daily/weekly caps are out of scope
    - _Requirements: 4.3, 4.5_

  - [x]* 5.8 Write example-based test for fare calculator distance bands
    - Pin the exact distance-band boundaries per mode (lower/upper edge values map to the expected fare value)
    - Assert walk and bicycle modes return `null`
    - _Requirements: 4.3, 4.5_

- [x] 6. Implement the secure TfNSW API client
  - [x] 6.1 Implement `TfnswClient` with secure key injection and resilience
    - Create `backend/src/tfnsw/client.ts` implementing `stopFinder(query)` and `trip(originId, destinationId, time, mode)`
    - Use base URL `https://api.transport.nsw.gov.au/v1/tp/` (read `TFNSW_BASE_URL` from env) and header `Authorization: apikey <key>` (read `TFNSW_API_KEY` from env only); never log or return the key or raw payloads
    - Send common params `outputFormat=rapidJSON` and `coordOutputFormat=EPSG:4326` on every request
    - `stop_finder` params: `type_sf=any`, `name_sf=<query>`, `TfNSWSF=true`, `anyMaxSizeHitList`, `odvSugMacro=1`
    - `trip` params: `type_origin=stop`, `name_origin=<id>`, `type_destination=stop`, `name_destination=<id>`, `depArrMacro=dep|arr`, `itdDate=YYYYMMDD`, `itdTime=HHMM`, `TfNSWTR=true`; `itdDate`/`itdTime` are Sydney-local time for the request
    - Apply bounded timeouts (search ≤ 3s, route ≤ 5s) and a single short retry with backoff on transient errors, surfacing `ServiceUnavailableError` on failure
    - Delegate response parsing to the normaliser from task 5
    - _Requirements: 1.1, 1.5, 2.2, 2.6, Security "API key protection"_

  - [x]* 6.2 Write unit tests for client error/timeout mapping
    - Mock the HTTP layer to assert transient errors trigger one retry then `ServiceUnavailableError`, and that the key never appears in errors/logs
    - _Requirements: 1.5, 2.6_

- [x] 7. Implement caching layer
  - [x] 7.1 Implement an in-memory LRU cache with TTL
    - Create `backend/src/infra/cache.ts` with get/set and per-entry TTL
    - Wrap `TfnswClient` calls: stop-finder keyed by normalised (lowercased, trimmed) query with ~24h TTL; trip keyed by `(originId, destinationId, time-bucket)` with ~60s TTL
    - _Requirements: Design "Caching Strategy"_

  - [x]* 7.2 Write unit tests for cache hit/miss and TTL expiry
    - Test key normalisation, hit on repeat call, and expiry after TTL
    - _Requirements: Design "Caching Strategy"_

- [x] 8. Implement the Location and Route services
  - [x] 8.1 Implement `LocationService.searchLocations`
    - Create `backend/src/services/locationService.ts`: guard trimmed query length < 3 (return empty, do not call client), otherwise call cached `TfnswClient.stopFinder` and return up to 10 `Location[]`
    - _Requirements: 1.1, 1.4, 1.6_

  - [x]* 8.2 Write property test for short-query guard
    - **Property 3: Short queries never reach the API**
    - **Validates: Requirements 1.6**

  - [x] 8.3 Implement `RouteService.planRoutes`
    - Create `backend/src/services/routeService.ts`: validate `originId !== destinationId` (raise `ValidationError`, no client call), fetch + normalise journeys, then call the ranking engine to populate `fastestId`, `economicalId`, and `comparison` into `RouteResult`
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 4.1, 5.1, 5.3, 5.4, 5.6_

  - [x]* 8.4 Write property test for identical origin/destination rejection
    - **Property 6: Identical origin and destination are rejected**
    - **Validates: Requirements 2.5**

  - [x]* 8.5 Write unit tests for empty-result behaviors
    - Empty location list returns empty (drives "no locations found"); empty journey list returns empty result (drives "no routes found")
    - _Requirements: 1.4, 2.4_

- [x] 9. Implement REST API layer with validation, rate limiting, and CORS
  - [x] 9.1 Implement input validation and rate-limiting middleware
    - Create `backend/src/api/middleware.ts`: validate/allowlist query params (query length bounds, location-id format, ISO time format), per-IP and global rate limiting, and CORS restricted to `ALLOWED_ORIGINS`
    - _Requirements: 2.5, Security "Unauthenticated public endpoints"_

  - [x] 9.2 Implement REST controllers and wire services
    - Create `backend/src/api/routes.ts` exposing `GET /api/locations` and `GET /api/routes` (no journey-id detail endpoint — the `/api/routes` response already carries full leg-by-leg detail for every journey)
    - Wire `LocationService` and `RouteService`; map typed errors to the JSON envelope and status codes; set `Cache-Control` headers
    - Do NOT add a `getJourney`/journey-lookup handler and do NOT use `NotFoundError` for journey lookup — there is no journey-detail-by-id retrieval
    - Create `backend/src/server.ts` that mounts middleware and controllers and reads config from env
    - _Requirements: 1.1, 2.2, 3.2, 4.2, 5.5, 3.4_

  - [x]* 9.3 Write integration tests for the wired backend
    - Assert `TfnswClient` sends the `Authorization` header and parses recorded EFA stop-finder and trip responses into domain models; assert rate limiting rejects requests above threshold; smoke-check the 3s/5s budgets against recorded endpoints
    - _Requirements: 1.1, 2.2, Security, Design "Testing Strategy"_

- [x] 10. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement the mobile-first web frontend
  - [x] 11.1 Set up the SPA shell, API client, and responsive layout
    - Create `frontend/src/api/client.ts` calling the backend endpoints; establish mobile-first responsive breakpoints and the app shell
    - _Requirements: Design "Mobile-first responsive UI"_

  - [x] 11.2 Implement `LocationSearchField` with debounce and states
    - Debounced autocomplete enforcing the 3-character minimum, clearing results below threshold; render selectable results (name, type, suburb); store selection in the originating field; show "no locations found" and "service temporarily unavailable" while retaining typed text
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x]* 11.3 Write unit tests for search field behaviors
    - Selecting a location stores it in the originating field; empty result renders "no locations found"; upstream failure retains typed text
    - _Requirements: 1.3, 1.4, 1.5_

  - [x] 11.4 Implement `RouteSearchController` and `RouteList`
    - Enable route search only when both origin and destination are selected and differ (else show same-location validation); render up to 5 routes ordered by departure with departure/arrival, travel time, transfers, modes; badge fastest and economical; show "no routes found" + suggestion; retain selections on upstream failure
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 4.1_

  - [x]* 11.5 Write unit tests for route search enable/disable and empty state
    - Search enable/disable based on selection; empty route result renders the "no routes found" + suggestion message
    - _Requirements: 2.1, 2.4_

  - [x] 11.6 Implement `JourneyDetailView` with retry
    - Render full leg-by-leg details (per-leg departure/arrival, mode, platform where available, per-leg + total fare for the economical selection); provide a retry action when detail retrieval fails
    - _Requirements: 3.2, 4.2, 5.5, 3.4_

  - [x]* 11.7 Write unit tests for detail rendering and retry
    - Detail view renders leg info including platform when present; detail fetch failure shows error and exposes retry
    - _Requirements: 3.2, 4.2, 5.5, 3.4_

  - [x] 11.8 Implement `RouteComparisonView`
    - Side-by-side fastest vs economical with total travel time (h/m), total fare (AUD two decimals via the formatter), transfers, and modes; show travel-time and fare differences with faster/cheaper labels; collapse to a single route when they coincide; show the "fare unavailable for fastest" notice and compare on time + transfers only
    - Reuse the formatting helpers from the shared package (`shared/src/format.ts`, task 2.1)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

  - [x]* 11.9 Write unit and responsive snapshot tests for comparison view
    - Comparison renders both entries side by side; snapshot tests confirm mobile-first breakpoints render correctly across phone and desktop widths
    - _Requirements: 5.1, Design "Frontend / Responsive Tests"_

  - [x] 11.10 Adjust `JourneyDetailView` to render from fetched route data (follow-up to 11.6)
    - Change `JourneyDetailView` to render from the already-fetched journey passed in as a prop from the route result, instead of fetching by id via `ApiClient.getJourney`
    - Remove the journey-by-id fetch path and the `getJourney` usage from the frontend API client (`frontend/src/api/client.ts`); there is no journey-detail endpoint
    - Make the retry action re-trigger the parent route search rather than re-fetch a single journey
    - _Requirements: 3.2, 4.2, 5.5, 3.4_

- [x] 12. Final integration and wiring
  - [x] 12.1 Wire the full frontend flow end to end
    - Connect search → route discovery → ranking/comparison → detail across the SPA using the backend API client, ensuring state (selections, typed text) is retained per the error-handling rules
    - _Requirements: 1.3, 2.1, 2.6, 3.4, 5.1, 5.5_

  - [x]* 12.2 Write a frontend integration test for the happy-path flow
    - Drive search → results → route list → comparison → detail against a mocked backend
    - _Requirements: 1.1, 2.2, 5.1, 5.5_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, though they validate the design's correctness properties and key behaviors.
- Property/unit test tasks that are scheduled in the same wave MUST live in separate test files to avoid write collisions. In particular, the journeyMath tests 3.2 and 3.3 go in distinct files, and the rankingEngine test group 3.5, 3.6, 3.8, 3.9, and 3.10 each go in distinct files.
- The Opal Fare Calculator (task 5.7) must be implemented before journey normalisation (task 5.4), which calls it to populate per-leg fares; the model extension (task 1.4) must also precede 5.4. The fare-calculator example test (5.8) validates band boundaries by example, not as a correctness property.
- Task 5.8 is an example-based test (distance-band boundaries), consistent with the design's decision to validate the fare calculator's band mapping by example rather than by a universal property.
- The frontend `JourneyDetailView` follow-up (task 11.10) renders from already-fetched route data rather than fetching by journey id; there is no journey-detail endpoint, so the detail-view test (11.7) targets the prop-driven component.
- Each property test must use `fast-check`, run a minimum of 100 iterations, and carry the tag `Feature: tfnsw-route-planner, Property {N}: {text}`.
- The TfNSW API key is read only from the backend environment (`TFNSW_API_KEY`, with `TFNSW_BASE_URL`) and must never be committed, logged, or returned to clients.
- Each task references specific requirements (and design sections for cross-cutting concerns) for traceability.
- Checkpoints provide incremental validation between major build phases.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.4", "5.7", "3.3", "11.3", "11.10"] },
    { "id": 1, "tasks": ["3.5", "3.6", "3.7", "5.2", "5.3", "5.4", "5.8", "11.7", "11.8"] },
    { "id": 2, "tasks": ["3.8", "3.9", "3.10", "5.5", "5.6", "6.1", "11.9"] },
    { "id": 3, "tasks": ["6.2", "7.1"] },
    { "id": 4, "tasks": ["7.2", "8.1", "8.3"] },
    { "id": 5, "tasks": ["8.2", "8.4", "8.5", "9.1"] },
    { "id": 6, "tasks": ["9.2"] },
    { "id": 7, "tasks": ["9.3", "12.1"] },
    { "id": 8, "tasks": ["12.2"] }
  ]
}
```

## Enhancements

These tasks layer the prioritised search, earlier+later window, mode selection, and time filter onto the completed build above. They follow the updated design (Location Prioritisation Algorithm, Earlier + Later Window, mode-exclusion mapping, and the `when`/`modes` REST params) and reuse the existing TypeScript stack and `fast-check` conventions. All earlier tasks (1–13) are complete and unchanged.

- [ ] 14. Extend domain models for prioritisation, time filter, and mode selection
  - [ ] 14.1 Add new model fields and the selectable-mode type
    - In `backend/src/domain/models.ts`, add `modes: TransportMode[]` and `matchQuality: number` to `Location` (served modes drive priority tier and display; `matchQuality` orders within a tier, defaulting to 0)
    - Add `depArr: 'dep' | 'arr'` and `includedModes: TransportMode[]` to `RouteRequest` ('dep' = Leave now / Leave at, 'arr' = Arrive by; empty or full `includedModes` ⇒ no exclusion)
    - Add the `SelectableMode` union (`'train' | 'metro' | 'lightRail' | 'bus' | 'coach' | 'ferry' | 'school'`) for the seven user-selectable Transport_Modes
    - _Requirements: 1.3, 6.1, 6.3, 7.3, 7.4_

- [ ] 15. Implement location normalisation modes/matchQuality and the prioritisation algorithm
  - [ ] 15.1 Carry modes/matchQuality through the normaliser, add `prioritiseLocations`, and remove the journey cap
    - In `backend/src/tfnsw/normalise.ts`, update `normaliseLocations` to map the stop_finder `modes` integer codes via the `class`→mode table (1 train, 2 metro, 4 lightRail, 5 bus, 7 coach, 9 ferry, 11 school) into a deduplicated `Location.modes`, and carry `matchQuality` (default 0 when absent)
    - Add a pure `prioritiseLocations(locations)` implementing the Location Prioritisation Algorithm: assign a priority tier (1 train/metro station, 2 ferry, 3 bus, 4 other transit incl. light rail/coach/school, 5 address/POI/suburb; multi-mode locations take the lowest/best tier), stable-sort by `(tier ascending, matchQuality descending)`, then cap at the first 10
    - Remove the 5-entry cap from `normaliseJourneys` (the merge window in the Route Service now owns the result count); keep `departureTime` ordering
    - _Requirements: 1.2, 1.3, 1.4, 2.2_

  - [ ]* 15.2 Write property test for location prioritisation ordering
    - New file `backend/src/tfnsw/normalise.prioritise.test.ts`
    - **Property 15: Location prioritisation orders by tier then match quality**
    - **Validates: Requirements 1.3, 1.4**

  - [ ]* 15.3 Update existing normaliser tests for the new Location fields and the journey-cap removal
    - Update `normalise.cap.test.ts` (location-result cap of 10 now lives in prioritisation; remove/adjust the journey 5-cap expectation), `normalise.completeness.test.ts` (assert `modes` + `matchQuality` populated), `normalise.roundtrip.test.ts` (round-trip the new fields), `normalise.journeys.test.ts` (no longer capped at 5), and `normalise.distance.test.ts` (unchanged distance assertions still pass against the new shape)
    - _Requirements: 1.2, 1.3, 2.2_

- [ ] 16. Add mode exclusion and the params-object trip signature to the TfNSW client
  - [ ] 16.1 Change `trip(...)` to a params object and emit mode-exclusion params
    - In `backend/src/tfnsw/client.ts`, change `trip(...)` to accept `{ originId, destinationId, time, depArr, calcNumberOfTrips?, excludedModes? }` with `depArrMacro=dep|arr` and `calcNumberOfTrips` defaulting to 6
    - For each excluded mode emit `exclMOT_<code>=1` (codes 1/2/4/5/7/9/11) plus a single `excludedMeans=checkbox`; when `excludedModes` is empty, send NO exclusion params
    - Update callers/tests broken by the new signature: `backend/src/services/routeService.ts` (call site), `backend/src/tfnsw/client.test.ts`, and `backend/src/api/routes.integration.test.ts`
    - _Requirements: 6.3, 7.3, 7.4_

  - [ ]* 16.2 Write property test for the mode-exclusion mapping
    - New file `backend/src/tfnsw/client.modeExclusion.test.ts`
    - **Property 16: Mode-exclusion mapping emits the complement of included modes**
    - **Validates: Requirements 6.3**

- [ ] 17. Implement the earlier+later window in the Route Service
  - [ ] 17.1 Issue two trip queries, merge, de-duplicate, and order the window
    - In `backend/src/services/routeService.ts`, issue two `trip` queries (forward + opposite direction) around the Selected_Time, merge their journeys, de-duplicate by the stable signature `(first leg origin stop, last leg destination stop, departureTime, arrivalTime)`, and order by non-decreasing `departureTime`, guaranteeing at least 5 earlier trips when the opposite-direction query offers them
    - Map `includedModes` to its excluded complement and apply it identically to BOTH queries
    - Include `depArr`, a canonical `includedModes` signature, and the time bucket in the trip cache key
    - Update `backend/src/services/routeService.test.ts` and `backend/src/services/services.emptyResults.test.ts` as needed for the two-query window
    - _Requirements: 2.2, 7.3, 7.4, 7.5_

  - [ ]* 17.2 Write property test for the merged journey window
    - New file `backend/src/services/routeService.window.test.ts`
    - **Property 4: Journey window is ordered, de-duplicated, and includes earlier trips**
    - **Validates: Requirements 2.2**

- [ ] 18. Extend the REST API and middleware for `when` and `modes`
  - [ ] 18.1 Parse, allowlist, and map the new query parameters
    - In `backend/src/api/routes.ts`, accept `when=leaveNow|leaveAt|arriveBy` and `modes` (comma-separated codes or names) on `GET /api/routes`
    - In `backend/src/api/middleware.ts`, extend `validateRouteParams` to allowlist `when` (three values) and each `modes` entry (the seven selectable modes), map `when`→`depArr` (`leaveNow`/`leaveAt`→`dep`, `arriveBy`→`arr`) and `modes`→`includedModes`; an explicit all-deselected (empty) `modes` set raises `ValidationError` (omitted `modes` ⇒ include everything)
    - Update `backend/src/api/routes.integration.test.ts` and add an all-deselected `modes`→400 case
    - _Requirements: 6.1, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 19. Implement the frontend time filter, mode selection, and merged-window rendering
  - [ ] 19.1 Add the controls, update the API client/contract, and wire the search flow
    - Add `frontend/src/components/TimeFilterControl.tsx` (Leave now default / Leave at / Arrive by, with a datetime input for the latter two) and `frontend/src/components/ModeSelectionControl.tsx` (seven checkboxes, all on by default, all-deselected validation)
    - Update `frontend/src/api/client.ts` `ApiClient.planRoutes` and `frontend/src/api/types.ts` to carry `when` and `modes`
    - Update `RouteSearchController` to pass `timeFilter` + Selected_Time + `includedModes` and enforce the all-modes-deselected validation before searching; update `LocationSearchField` to show served modes; update `RouteList` to render the merged window; wire both controls into `App.tsx`
    - _Requirements: 1.3, 2.2, 6.1, 6.2, 6.4, 7.1, 7.2_

  - [ ]* 19.2 Write unit tests for the new controls and update affected frontend tests
    - Add tests for `TimeFilterControl` (default Leave now, datetime shown for Leave at / Arrive by) and `ModeSelectionControl` (all on by default, all-deselected validation message); update existing frontend tests affected by the new `planRoutes` signature
    - _Requirements: 6.1, 6.2, 6.4, 7.1, 7.2_

- [ ] 20. Enhancement checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise. Run the TypeScript typecheck and build, run the full Vitest suite to green, and note that the live smoke test (`backend/src/scripts/smokeTest.ts`) should be re-run manually against the real TfNSW API.

## Enhancement Notes

- Tasks marked with `*` are optional test tasks; the core implementation tasks (14.1, 15.1, 16.1, 17.1, 18.1, 19.1) are not optional.
- The enhancement property tests reuse the design's correctness properties: Property 15 (prioritisation), Property 16 (mode-exclusion mapping), and Property 4 (merged window). Each must use `fast-check`, run a minimum of 100 iterations, and carry the tag `Feature: tfnsw-route-planner, Property {N}: {text}`.
- Build order: models first (14), then the independent normaliser (15) and TfNSW client (16) in parallel, then the Route Service window (17) that consumes both, then the REST/middleware mapping (18), then the frontend (19), then the test wave and a final checkpoint (20).
- Optional test sub-tasks are grouped into a single later wave per the requested ordering; each lives in its own file to avoid write collisions.

## Enhancement Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["14.1"] },
    { "id": 1, "tasks": ["15.1", "16.1"] },
    { "id": 2, "tasks": ["17.1"] },
    { "id": 3, "tasks": ["18.1"] },
    { "id": 4, "tasks": ["19.1"] },
    { "id": 5, "tasks": ["15.2", "15.3", "16.2", "17.2", "19.2"] }
  ]
}
```
