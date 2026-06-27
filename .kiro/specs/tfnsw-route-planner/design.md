# Design Document

## Overview

The TfNSW Route Planner is a responsive, mobile-first web application that lets commuters search for transport locations, discover routes between an origin and a destination, and compare the fastest and most economical journey options using live data from the Transport for NSW (TfNSW) Trip Planner API.

The system is split into two deployable tiers:

1. **Web frontend** — a mobile-first single-page application (SPA) that handles search input, route display, route selection, and the side-by-side comparison view.
2. **Backend API proxy / service layer** — a stateless service that mediates all calls to the TfNSW API. It protects the API key, normalises the EFA (Elektronische Fahrplanauskunft) response format into clean domain models, applies caching, and houses the route-selection logic (fastest / economical / comparison).

This split is deliberate. The TfNSW API key must never be exposed to a browser or mobile client, and the planned native Android app must be able to reuse the same business logic. By placing location normalisation, route ranking, fare aggregation, and comparison logic in the backend service layer, both the web frontend and the future Android app become thin presentation clients over a single, well-tested API.

### Research Summary

Key findings that inform this design, verified against the official TfNSW Trip Planner API Swagger schema (efa11, `tripplanner_v1_swag_efa11_20251002.yml`) and the EFA response format:

- The **Trip Planner API** uses a single API key obtained from the TfNSW Open Data Hub, passed as an `Authorization: apikey <key>` HTTP header on every request. The base URL is `https://api.transport.nsw.gov.au/v1/tp/`. (Content was rephrased for compliance with licensing restrictions.)
- This feature uses two endpoints, both returning `rapidJSON` with coordinates in `EPSG:4326`:
  - **Stop Finder** (`stop_finder`) — autocomplete location search returning stops, stations, wharves, addresses, and points of interest with `id`, `name`, `disassembledName`, `coord`, `type`, `parent`, `matchQuality`, `isBest`, and `modes`.
  - **Trip Planner** (`trip`) — returns a set of `journeys`, each containing only `legs`, `rating`, and `isAdditional` (there is **no journey id**). Each leg carries `transportation.product.class` (an integer mode code), `duration` (seconds), `distance` (metres), and timing fields on its `origin`/`destination` stops.
- The API is EFA-based and returns JSON. Responses are verbose and nested; the backend normalises them into compact domain models.
- **Fares are NOT returned by the trip endpoint (critical).** The trip response contains no Opal fare or ticket data: the schema's `TripRequestResponseJourneyFareZone` is documented as "Not currently used", and legs only carry a `DIFFERENT_FARES` string flag (not a price). Opal fares must therefore be **computed by the backend** from each leg's `distance` and mode using the separate Opal Fares dataset — see the Opal Fare Calculator component. Computed fares are **estimates** and the UI must indicate this.
- **GTFS-Realtime Vehicle Positions** (live GPS) is available as a separate feed and is reserved as a later nice-to-have; it is out of scope for this design.

### Route Selection Rules (from requirements)

- **Fastest route** = lowest total `Travel_Time`. Tiebreak: fewest transfers.
- **Economical route** = lowest total `Fare_Cost`. Tiebreak: shortest `Travel_Time`. Routes with no fare data are excluded from economical ranking.

## Architecture

```mermaid
graph TD
    subgraph Clients
        Web[Mobile-first Web SPA]
        Android[Future Android App]
    end

    subgraph Backend["Backend API Proxy / Service Layer"]
        REST[REST API Controllers]
        LocSvc[Location Service]
        RouteSvc[Route Service]
        RankSvc[Route Ranking & Comparison Engine]
        TfnswClient[TfNSW API Client + Normaliser]
        FareCalc[Opal Fare Calculator]
        FareData[[Opal Fare Tables: Distance Bands + Fare Values]]
        Cache[(Response Cache)]
        KeyVault[[API Key Secret Store]]
    end

    TfNSW[TfNSW Trip Planner API]

    Web -->|HTTPS JSON| REST
    Android -.future.-> REST
    REST --> LocSvc
    REST --> RouteSvc
    RouteSvc --> RankSvc
    LocSvc --> TfnswClient
    RouteSvc --> TfnswClient
    TfnswClient --> FareCalc
    FareCalc --> FareData
    TfnswClient --> Cache
    TfnswClient -->|Authorization: apikey| TfNSW
    TfnswClient --> KeyVault
```

### Architectural Principles

- **Thin clients, smart backend**: All TfNSW integration, normalisation, ranking, and comparison logic lives in the backend so it is shared and tested once.
- **API key isolation**: The key is read from a secret store / environment variable on the backend only. It is never sent to clients and never appears in client-bound responses or logs.
- **Statelessness**: The backend holds no per-user session state. Each request carries the data it needs (selected origin/destination IDs, time). This keeps the service horizontally scalable and equally consumable by web and Android.
- **Normalisation boundary**: The `TfNSW API Client + Normaliser` is the only component aware of the raw EFA JSON shape. Everything above it works with clean domain models (`Location`, `Journey`, `Leg`, `Fare`, `RouteComparison`).
- **Fares are computed, not fetched**: Because the trip endpoint returns no Opal fare data, the `Opal Fare Calculator` derives each leg's fare from its `distance` (metres) and mode using the separately maintained Opal fare tables. All fares surfaced to clients are estimates.
- **Mobile-first responsive UI**: The frontend uses responsive layout breakpoints so the same components scale from phone to desktop, easing the later Android port.

### Request Flows

**Location search (Requirement 1):**
```mermaid
sequenceDiagram
    participant U as User
    participant W as Web SPA
    participant B as Backend
    participant T as TfNSW API
    U->>W: types >= 3 chars (debounced)
    W->>B: GET /api/locations?query=...
    B->>B: check cache
    B->>T: stop_finder (Authorization: apikey)
    T-->>B: EFA locations JSON
    B->>B: normalise -> Location[] (carry modes + matchQuality)
    B->>B: order by priority tier then matchQuality; cap at 10
    B-->>W: Location[]
    W-->>U: selectable result list (shows type + modes)
```

**Route discovery + ranking (Requirements 2-7):**
```mermaid
sequenceDiagram
    participant W as Web SPA
    participant B as Backend
    participant T as TfNSW API
    W->>B: GET /api/routes?originId=&destId=&time=&when=&modes=
    B->>B: validate origin != destination; validate when/modes (>=1 mode)
    B->>B: derive depArr + excludedModes (complement of includedModes)
    B->>T: trip forward query (depArr, calcNumberOfTrips~6, exclMOT for excluded)
    B->>T: trip opposite-direction query (for earlier/later window)
    T-->>B: EFA journeys JSON (no fares) x2
    B->>B: merge + de-duplicate + order by departureTime (>=5 earlier when available)
    B->>B: compute per-leg Opal fare estimates (distance + mode)
    B->>B: assign synthetic journey ids; compute fastest, economical, comparison
    B-->>W: RouteResult { journeys, fastestId, economicalId, comparison }
```

## Components and Interfaces

### Frontend Components

- **LocationSearchField** — Debounced autocomplete input (origin and destination instances). Enforces the 3-character minimum, clears results below threshold, renders the selectable result list (name, type, suburb, and served **modes** to reflect prioritisation), and surfaces "no locations found" / "service unavailable" states while retaining typed text. Results arrive already ordered by priority tier then match quality.
- **TimeFilterControl** — A Time_Filter control offering "Leave now", "Leave at", and "Arrive by", with a datetime input shown for the "Leave at" / "Arrive by" options. Defaults to **"Leave now"** (Req 7.1, 7.2). Emits the chosen filter and Selected_Time to the RouteSearchController.
- **ModeSelectionControl** — Checkboxes for the seven selectable Transport_Modes (Train, Metro, Light Rail, Bus, Coach, Ferry, School Bus), **all selected (on) by default** (Req 6.1, 6.2). When the user deselects every mode and attempts a search, it shows the "at least one Transport_Mode is required" validation message and blocks the search (Req 6.4).
- **RouteSearchController** — Enables route search only when both origin and destination are selected and they differ; otherwise shows the same-location validation message. Passes the `timeFilter` + Selected_Time + `includedModes` (from the Time Filter and Mode Selection controls) through to `planRoutes`, and enforces the all-modes-deselected validation before searching.
- **RouteList** — Renders the merged journey window ordered by departure time (the forward set plus at least 5 earlier trips when available); shows departure/arrival, total travel time, transfers, and transport modes. Visually badges the fastest and the economical routes.
- **JourneyDetailView** — Shows full leg-by-leg journey details (per-leg departure/arrival, mode, platform where available, and per-leg + total fare for the economical selection). Renders directly from the already-fetched journey data in the route result — no separate detail fetch is made — and clearly labels fares as estimates.
- **RouteComparisonView** — Side-by-side fastest vs economical presentation with travel-time and fare differences and faster/cheaper labels. Collapses to a single route when they coincide. Handles the "fare unavailable for fastest route" notice.

### Backend Interfaces

```typescript
// Location Service
interface LocationService {
  // Returns up to 10 normalised locations. Throws ServiceUnavailableError on upstream failure.
  searchLocations(query: string): Promise<Location[]>;
}

// Route Service
interface RouteService {
  // Validates inputs, then issues TWO trip queries (forward + opposite direction) to
  // build a window of journeys around the Selected_Time, merges and de-duplicates them,
  // orders by departure time, then computes ranking + comparison. Applies mode exclusion
  // to both queries. See "Earlier + Later Window" below.
  planRoutes(request: RouteRequest): Promise<RouteResult>;
}

// Route Ranking & Comparison Engine (pure functions over normalised journeys)
interface RouteRankingEngine {
  selectFastest(journeys: Journey[]): Journey | null;
  selectEconomical(journeys: Journey[]): Journey | null;
  buildComparison(fastest: Journey | null, economical: Journey | null): RouteComparison;
}

// TfNSW API Client + Normaliser (only component aware of EFA JSON)
interface TfnswClient {
  // Carries `modes` and `matchQuality` through the normaliser so the caller can
  // apply the Location Prioritisation Algorithm.
  stopFinder(query: string): Promise<Location[]>;

  // Issues a single trip query. `depArr` selects depart-at vs arrive-by
  // (depArrMacro=dep|arr). `calcNumberOfTrips` caps the number of trips the API
  // returns for this query (default 6). `excludedModes` is the set of selectable
  // modes to exclude: for each excluded mode the client emits exclMOT_<code>=1 and
  // adds excludedMeans=checkbox. When `excludedModes` is empty, NO exclusion params
  // are sent (all modes included).
  trip(params: {
    originId: string;
    destinationId: string;
    time: Date;                    // Selected_Time, converted to Sydney-local itdDate/itdTime
    depArr: 'dep' | 'arr';
    calcNumberOfTrips?: number;     // default 6
    excludedModes?: SelectableMode[];
  }): Promise<Journey[]>;
}

// Opal Fare Calculator (pure function over leg distance + mode)
// Computes an ESTIMATED adult Opal fare from distance bands per mode.
// Loads the Opal Distance Tables and Opal Fare Values as configuration/data.
interface OpalFareCalculator {
  // Returns an estimated fare for a single priced leg, or null if the mode is unpriceable
  // (e.g. walk/bicycle) or no band matches.
  estimateLegFare(distanceMetres: number, mode: TransportMode): Fare | null;
}
```

> **Fare calculator scope (decision):** The first implementation is a **distance-band estimate** — each mode maps the leg `distance` (metres) to a distance band, and each band maps to a fare value, with rail treated approximately. **Transfer discounts and daily/weekly fare caps are explicitly deferred** as a future enhancement. The Opal fare tables (distance bands and fare values) are loaded as configuration/data, not hard-coded into logic, so they can be updated when Opal pricing changes.

### Route Service — Earlier + Later Window (Req 2.2, 7.3–7.5)

The TfNSW `trip` endpoint returns trips in one direction from the requested time: a depart-at query yields trips at/after the time, and an arrive-by query yields trips arriving at/before the time. To satisfy Req 2.2 — a result that includes trips from the `Selected_Time` onward **plus at least 5 earlier trips** — the Route Service issues **two** queries and merges them.

**For a "Leave now" / "Leave at" search (`depArr = 'dep'`) at Selected_Time `T`:**
1. **Forward set** — `trip(depArr='dep', time=T, calcNumberOfTrips≈6)` → trips departing at/after `T`.
2. **Earlier set** — `trip(depArr='arr', time=T, calcNumberOfTrips≈6)` → trips arriving by `T`, which yields earlier *departures* than `T`.
3. **Merge** the two journey lists, **de-duplicate**, and **order by non-decreasing `departureTime`**.

**For an "Arrive by" search (`depArr = 'arr'`) at Selected_Time `T`:** mirror the strategy —
1. **Primary set** — `trip(depArr='arr', time=T, calcNumberOfTrips≈6)` → trips arriving at/before `T`.
2. **Later alternatives** — `trip(depArr='dep', time=T, calcNumberOfTrips≈6)` → trips departing at/after `T`, providing later options around `T`.
3. **Merge**, **de-duplicate**, and **order by departure time**, keeping a window around `T`.

**De-duplication signature:** because the trip API supplies no journey id, two journeys are considered the same when their **stable signature** matches — `(first leg origin stop, last leg destination stop, departureTime, arrivalTime)`. Duplicates that appear in both query results are collapsed to one entry.

**Earlier-trip guarantee:** when the API offers them, the merged result includes **at least 5** trips departing before the forward set's first trip. If the opposite-direction query returns fewer, the service includes as many as are available (the guarantee is "at least 5 when the API offers them").

**Mode exclusion applies to BOTH queries:** the excluded-modes set derived from `includedModes` is passed identically to the forward and earlier/later queries so the whole window respects the user's Mode_Selection.

### REST API Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/api/locations?query={q}` | Location autocomplete (Req 1) | None (public, see Security) |
| `GET` | `/api/routes?originId={o}&destinationId={d}&time={iso}&when={leaveNow\|leaveAt\|arriveBy}&modes={csv}` | Route discovery + ranking + comparison, with full leg-by-leg detail per journey (Req 2–7) | None (public, see Security) |

**`/api/routes` query parameters (Req 6, 7):**
- `when` — one of `leaveNow` \| `leaveAt` \| `arriveBy` (the Time_Filter). `leaveNow` and `leaveAt` map to `depArr='dep'`; `arriveBy` maps to `depArr='arr'`. Defaults to `leaveNow` when omitted.
- `time` — ISO 8601 Selected_Time. Required for `leaveAt` / `arriveBy`; ignored (server uses current time) for `leaveNow`.
- `modes` — comma-separated list of included selectable modes (codes or names, e.g. `train,bus,ferry` or `1,5,9`). Omitted or listing all modes ⇒ include everything (no exclusion).
- **Validation (allowlist):** `when` must be one of the three allowed values; each entry in `modes` must be an allowlisted selectable mode (train, metro, lightRail, bus, coach, ferry, school); `time` must be a valid ISO 8601 timestamp. **Deselecting all modes** (an empty `modes` set explicitly signalling "none selected") is a `ValidationError` and the route search is not performed (Req 6.4). Note: an *omitted* `modes` param means "all included", which is distinct from "none selected".

> **No journey-detail endpoint:** The TfNSW API has no journey id and no per-journey detail endpoint. The `/api/routes` response already contains complete leg-by-leg detail for every journey, so the detail view (Req 3.2, 4.2, 5.5) renders from the already-fetched data. The backend assigns a **synthetic** `id` to each journey (a hash/index of its content) purely so the client can select a journey from the result set.

> **Security note (flagged):** These endpoints are intentionally **unauthenticated** for end users — the app requires no login. This is a deliberate decision recorded in the Security section, not an oversight. The endpoints are public read-only proxies. Because they trigger upstream calls against a rate-limited, keyed third-party API, they MUST be protected by rate limiting and input validation to prevent abuse and quota exhaustion. See the Security section.

## Data Models

All models are the normalised, client-facing representations produced by the normaliser. They are independent of the raw EFA JSON.

```typescript
// A transport stop, station, platform, or point of interest.
interface Location {
  id: string;            // TfNSW location id (used as origin/destination)
  name: string;          // display name (full `name`, may include suburb)
  type: LocationType;    // mapped from EFA `type` (see EFA Response Mapping)
  suburb: string | null; // parent locality, where provided
  modes: TransportMode[];// served public-transport modes, mapped from the stop_finder
                         // `modes` integer codes (see EFA Response Mapping); empty when
                         // the location serves no transit (e.g. address/POI/suburb).
                         // Used both for result ordering (priority tier) and for display.
  matchQuality: number;  // EFA `matchQuality` (higher = better); used to order results
                         // within a priority tier. Defaults to 0 when absent.
  coord: {               // EFA `coord` is [latitude, longitude] (EPSG:4326)
    lat: number;
    lng: number;
  } | null;
}

type LocationType = 'stop' | 'station' | 'platform' | 'poi' | 'address' | 'suburb';
type TransportMode = 'train' | 'metro' | 'bus' | 'ferry' | 'lightRail' | 'coach' | 'walk' | 'bicycle' | 'school' | 'other';

// A single leg of a journey (one vehicle ride or a walk/transfer).
interface Leg {
  origin: LegStop;
  destination: LegStop;
  mode: TransportMode;        // derived from transportation.product.class
  routeName: string | null;   // e.g. "T1 North Shore Line", "389"
  departureTime: string;      // ISO 8601 UTC; estimated if present, else planned
  arrivalTime: string;        // ISO 8601 UTC; estimated if present, else planned
  durationMinutes: number;    // from EFA leg.duration (seconds) / 60
  distanceMetres: number | null; // EFA leg.distance, used for fare estimation
  isTransfer: boolean;        // true for walk/transfer connector legs
  fare: Fare | null;          // ESTIMATED per-leg adult Opal fare (computed, not from TfNSW)
}

interface LegStop {
  locationName: string;
  platform: string | null;    // derived from stop disassembledName/name/properties; may be null
  time: string;               // ISO 8601 UTC; estimated time if present, else planned
}

// Monetary fare value. Amounts are integer cents to avoid float rounding errors.
interface Fare {
  amountCents: number;        // >= 0, ESTIMATED adult Opal fare
  currency: 'AUD';
}

// A complete journey option from origin to destination.
interface Journey {
  id: string;                 // SYNTHETIC id assigned by the backend (hash/index of journey);
                              // NOT from TfNSW — the trip API has no journey id
  legs: Leg[];                // ordered, length >= 1
  departureTime: string;      // ISO 8601 = first leg departure
  arrivalTime: string;        // ISO 8601 = last leg arrival
  travelTimeMinutes: number;  // arrival - departure (includes transfer waits)
  transferCount: number;      // number of vehicle changes
  modes: TransportMode[];     // distinct transport modes used, in order
  totalFare: Fare | null;     // sum of ESTIMATED leg fares; null if any priced leg is unpriceable
}

// Request to plan routes.
interface RouteRequest {
  originId: string;
  destinationId: string;
  time: string;               // ISO 8601 Selected_Time (interpreted per `depArr` below)
  depArr: 'dep' | 'arr';      // 'dep' = depart at/after `time` (Leave now / Leave at);
                              // 'arr' = arrive at/before `time` (Arrive by).
                              // "Leave now" is modelled as depArr='dep' with time = current time.
  includedModes: TransportMode[]; // the priceable/transit modes to include in results.
                              // An empty list OR a list containing all selectable modes means
                              // "no exclusion" (include everything). Any strict, non-empty
                              // subset causes the complement to be excluded upstream.
                              // walk/bicycle are connectors and are never part of this set.
}

// The selectable public-transport modes a user can include/exclude (Requirement 6).
// Order matches the Mode_Selection control. walk/bicycle/other are NOT selectable.
type SelectableMode = 'train' | 'metro' | 'lightRail' | 'bus' | 'coach' | 'ferry' | 'school';

// Result of route discovery + ranking.
interface RouteResult {
  journeys: Journey[];        // the merged window: the forward set (from Selected_Time onward)
                              // PLUS at least 5 earlier trips when the API offers them,
                              // de-duplicated and ordered by non-decreasing departureTime.
                              // No longer capped at 5.
  fastestId: string | null;
  economicalId: string | null;
  comparison: RouteComparison;
}

// Side-by-side comparison of fastest vs economical (Requirement 5).
interface RouteComparison {
  fastest: ComparisonEntry | null;
  economical: ComparisonEntry | null;
  sameRoute: boolean;                 // true when fastest === economical
  travelTimeDifferenceMinutes: number | null; // |fastest - economical|
  fareDifferenceCents: number | null;          // |fastest - economical|, null if either fare missing
  fasterRouteId: string | null;
  cheaperRouteId: string | null;
  fareUnavailableForFastest: boolean; // Req 5.6
}

interface ComparisonEntry {
  journeyId: string;
  travelTimeMinutes: number;
  totalFare: Fare | null;
  transferCount: number;
  modes: TransportMode[];
}
```

### Model Notes

- **Money as integer cents**: `Fare.amountCents` avoids floating-point rounding. Display formatting (AUD to two decimals) happens at the presentation boundary.
- **Fares are estimates**: All `Fare` values are computed by the Opal Fare Calculator from leg distance and mode, not returned by TfNSW. The UI must label them as estimates.
- **Synthetic journey id**: `Journey.id` is assigned by the backend (e.g. a stable hash of the journey's legs/times, or its index in the result) solely for client-side selection. TfNSW supplies no journey id.
- **Travel time definition**: `travelTimeMinutes` is the difference between the last leg's arrival and the first leg's departure (estimated where available, else planned), inherently including transfer waiting time (Req 3.3).
- **Transfer count**: number of vehicle changes, derived from the count of non-walk vehicle legs minus one (floored at zero), matching the user-facing "number of transfers".
- **Fare aggregation**: `totalFare` is the sum of per-leg estimated fares. If any fare-bearing (priced) leg cannot be priced, `totalFare` is `null` and the journey is excluded from economical ranking (Req 4.4).
- **Location modes drive ordering and display**: `Location.modes` (mapped from the stop_finder `modes` integer codes) determines a location's priority tier for `Search_Results` ordering (Req 1.3) and is surfaced in the UI alongside `type`. `Location.matchQuality` orders results within a tier (Req 1.4).
- **Merged journey window**: `RouteResult.journeys` is no longer capped at 5. It is the de-duplicated union of a forward set (trips at/after the `Selected_Time`) and an earlier set (at least 5 prior trips when available), ordered by non-decreasing `departureTime`. See the Route Service two-query strategy below.
- **Mode inclusion semantics**: `RouteRequest.includedModes` lists the modes to include. The Route Service converts it to the complement set of modes to exclude before calling the client (empty or all-modes ⇒ exclude nothing). Deselecting every mode is a `ValidationError` and never reaches the client.

### Location Prioritisation Algorithm (normaliser)

The normaliser orders `Search_Results` so the most relevant transit locations appear first (Req 1.3, 1.4). The algorithm is a pure function over the normalised locations:

1. **Assign a priority tier** to each `Location` from its `type` and served `modes`:
   - **Tier 1** — train or metro stations (`modes` includes `train` or `metro`; `type` station/stop/platform).
   - **Tier 2** — ferry wharves (`modes` includes `ferry`).
   - **Tier 3** — bus stops (`modes` includes `bus`).
   - **Tier 4** — other public-transport stops, including light rail, coach, and school bus (`modes` includes any of `lightRail` / `coach` / `school` but none of the higher tiers).
   - **Tier 5** — non-transit locations: addresses, points of interest, and suburbs (`type` ∈ {`address`, `poi`, `suburb`} or empty `modes`).
   - When a location serves modes spanning multiple tiers, it takes the **lowest (best) tier number** among them (e.g. an interchange serving both train and bus is Tier 1).
2. **Sort** the full list by `(tier ascending, matchQuality descending)`. The sort is stable, so equal `(tier, matchQuality)` entries retain their upstream order.
3. **Cap** the sorted list at the first **10** entries.

### EFA Response Mapping

The normaliser is the only component aware of the raw EFA JSON. Verified mappings against the efa11 Swagger schema:

**Stop Finder (location) fields:**
- `id` → `Location.id`; `name` → `Location.name`; `disassembledName` is the short name (no suburb) used for display/platform hints.
- `coord` is `[latitude, longitude]` (latitude first; `coordOutputFormat=EPSG:4326`) → `coord.lat`, `coord.lng`.
- `type` enum is one of `poi | singlehouse | stop | platform | street | locality | suburb | address | unknown`. Mapping to `LocationType`:
  - `stop` → `stop`, `platform` → `platform`, `poi` → `poi`
  - `singlehouse` / `street` / `address` → `address`
  - `locality` / `suburb` → `suburb`
  - **`unknown` → dropped** (the schema states these indicate bad data and can be safely ignored).
- `parent` (`ParentLocation`) supplies the suburb/locality where present → `Location.suburb`.
- `matchQuality` (higher = better) → `Location.matchQuality` (defaulting to 0 when absent); used to **sort** results within a priority tier. `isBest` flags the best match.
- `modes[]` are integer mode codes → mapped to `Location.modes` (a deduplicated `TransportMode[]`) using the same `class` → mode table as legs (see Transport mode table below: 1 train, 2 metro, 4 light rail, 5 bus, 7 coach, 9 ferry, 11 school bus). Previously dropped; now carried through the normaliser to drive ordering and display.

**Journey fields:**
- A journey has only `legs`, `rating`, and `isAdditional` — **there is no journey id field**. `Journey.id` is backend-assigned (synthetic).

**Leg fields:**
- Times live on the **stops**, not the leg: `origin.departureTimePlanned` / `origin.departureTimeEstimated` and `destination.arrivalTimePlanned` / `destination.arrivalTimeEstimated`, in ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`). Use the **estimated** value when present (real-time), otherwise the **planned** value.
- `leg.duration` is in **seconds**; `leg.distance` is in **metres** (used by the fare calculator).
- Each intermediate stop in `stopSequence` may carry both arrival and departure times.
- **Platform** is not a dedicated field — derive it from the stop's `disassembledName` / `name` (or `properties` where available); may be `null`.

**Transport mode** — derive from `transportation.product.class` (integer):

| `class` | TransportMode |
|---|---|
| 1 | `train` |
| 2 | `metro` |
| 4 | `lightRail` |
| 5 | `bus` |
| 7 | `coach` |
| 9 | `ferry` |
| 11 | `school` (School Bus) |
| 99 / 100 | `walk` |
| 101 | `bicycle` |

Walk (`99`/`100`) and bicycle (`101`) legs are treated as transfers/connectors and are unpriced by the fare calculator.

**Fares:** The trip response carries **no fare data** — `TripRequestResponseJourneyFareZone` is "Not currently used", and legs only expose a `DIFFERENT_FARES` string flag (not a price). The normaliser therefore populates each priced leg's `fare` by calling the Opal Fare Calculator with the leg's `distance` and `mode`.

### TfNSW Client Request Details

All requests use base URL `https://api.transport.nsw.gov.au/v1/tp/`, header `Authorization: apikey <key>`, and common params `outputFormat=rapidJSON`, `coordOutputFormat=EPSG:4326`.

- **`stop_finder`**: `type_sf=any`, `name_sf=<query>`, `TfNSWSF=true`, `anyMaxSizeHitList`, `odvSugMacro=1`. The normaliser retains each location's `modes` and `matchQuality` (previously dropped) so the Location Service can order results by priority tier and match quality.
- **`trip`**: `type_origin=stop`, `name_origin=<id>`, `type_destination=stop`, `name_destination=<id>`, `depArrMacro=dep|arr`, `itdDate=YYYYMMDD`, `itdTime=HHMM`, `calcNumberOfTrips=<int>` (max trips per query, default 6), `TfNSWTR=true`. The `itdDate`/`itdTime` values are **Sydney local** time for the request.
  - **Mode exclusion**: to restrict results to a chosen set of modes, the client excludes the complement. For each excluded mode it sends `exclMOT_<code>=1` and additionally sends `excludedMeans=checkbox`. Mode codes: `1` train, `2` metro, `4` light rail, `5` bus, `7` coach, `9` ferry, `11` school bus. When all modes are included, **no** `excludedMeans`/`exclMOT_*` params are sent.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The route-ranking engine, fare aggregation, comparison math, formatting helpers, the EFA normaliser, the location prioritisation ordering, the journey-window merge, and the mode-exclusion parameter mapping are all pure functions over data, making them excellent candidates for property-based testing. The properties below are derived from the prework analysis. UI interactions (Time Filter / Mode Selection controls), empty-state messaging, the all-modes-deselected validation, and upstream error handling are validated by example-based and edge-case tests (see Testing Strategy) rather than properties.

> **Fare calculator note:** The Opal Fare Calculator's distance-band mapping (which band a given distance falls into, and the fare value for that band) is validated by **example-based tests** that pin the exact band boundaries per mode, rather than by a universal property. The fare *aggregation* logic that consumes calculator output (Property 8) and the economical-selection logic (Property 9) remain property-based, since they operate on the domain model independent of how individual fares were derived.

### Property 1: Location results are capped at 10

*For any* upstream stop-finder response containing N location entries, the normalised location list returned by `searchLocations` has length equal to `min(N, 10)`.

**Validates: Requirements 1.1**

### Property 2: Normalised locations are complete

*For any* upstream location entry, the resulting normalised `Location` has a non-empty `name` and a `type` drawn from the valid `LocationType` set.

**Validates: Requirements 1.2**

### Property 3: Short queries never reach the API

*For any* query string whose trimmed length is less than 3, `searchLocations` does not invoke the TfNSW client and yields an empty result set (clearing any previous results).

**Validates: Requirements 1.6**

### Property 4: Journey window is ordered, de-duplicated, and includes earlier trips

*For any* forward set of journeys (at/after the Selected_Time) and any earlier/opposite-direction set produced by the two-query strategy, the merged `RouteResult.journeys` is ordered by non-decreasing `departureTime`, contains no two journeys with the same stable signature `(first origin stop, last destination stop, departureTime, arrivalTime)`, and — whenever the earlier set offers at least 5 journeys departing before the forward set's first trip — includes at least 5 such earlier trips.

**Validates: Requirements 2.2, 7.3, 7.4, 7.5**

### Property 5: Travel time equals arrival minus departure including transfer waits

*For any* journey, `travelTimeMinutes` equals the number of minutes between the first leg's scheduled departure and the last leg's scheduled arrival (which inherently includes transfer waiting time).

**Validates: Requirements 2.3, 3.3**

### Property 6: Identical origin and destination are rejected

*For any* location id, calling `planRoutes` with that id as both origin and destination raises a validation error and does not invoke the TfNSW client.

**Validates: Requirements 2.5**

### Property 7: Fastest selection minimises travel time then transfers

*For any* non-empty journey list, the journey chosen by `selectFastest` has a `travelTimeMinutes` less than or equal to every other journey's, and among all journeys sharing that minimum travel time, none has a strictly smaller `transferCount` than the chosen one.

**Validates: Requirements 3.1**

### Property 8: Total fare equals the sum of leg fares

*For any* journey whose fare-bearing legs all have fare data, `totalFare.amountCents` equals the sum of the `amountCents` of its legs.

**Validates: Requirements 4.2**

### Property 9: Economical selection minimises fare among priced routes and excludes unpriced routes

*For any* journey list, if `selectEconomical` returns a journey then that journey has a non-null `totalFare` whose `amountCents` is less than or equal to every other priced journey's, and among journeys sharing that minimum fare none has a strictly shorter `travelTimeMinutes`; journeys with null `totalFare` are never selected.

**Validates: Requirements 4.1, 4.4**

### Property 10: Comparison differences and faster/cheaper labels are consistent

*For any* two journeys (a fastest and an economical), the `RouteComparison` reports `travelTimeDifferenceMinutes` equal to the absolute difference of their travel times, `fareDifferenceCents` equal to the absolute difference of their fares (or null when either fare is missing), and labels `fasterRouteId` / `cheaperRouteId` as the journey with the lower travel time / fare respectively.

**Validates: Requirements 5.3**

### Property 11: Formatting helpers are exact and reversible

*For any* non-negative cents value, the AUD formatter produces a string with exactly two decimal places whose numeric value equals `cents / 100`; and *for any* non-negative minutes value, the duration formatter produces hours and minutes that recompose to the original minutes value.

**Validates: Requirements 5.2**

### Property 12: Coinciding fastest and economical collapse to a single route

*For any* journey list in which one journey is simultaneously the fastest and the economical selection, `buildComparison` sets `sameRoute` to true and presents that single journey as both the fastest and most economical option.

**Validates: Requirements 5.4**

### Property 13: Missing fare on the fastest route is handled in comparison

*For any* journey list whose fastest journey has a null `totalFare`, `buildComparison` sets `fareUnavailableForFastest` to true and `fareDifferenceCents` to null, while still reporting travel time and transfer count.

**Validates: Requirements 5.6**

### Property 14: EFA normalisation round-trip

*For any* valid domain `Location` or `Journey`, encoding it into an EFA-shaped payload — using the verified field mappings (location `coord` as `[lat, lng]`, `type` enum mapping, leg times on the `origin`/`destination` stops via `departureTimePlanned`/`departureTimeEstimated` and `arrivalTimePlanned`/`arrivalTimeEstimated`, `leg.duration` in seconds, `leg.distance` in metres, and mode from `transportation.product.class`) — and passing it through the normaliser reproduces an equivalent domain model for all fields the TfNSW API carries. (The synthetic `Journey.id` and the computed `fare`/`totalFare` are excluded, since they are not part of the upstream payload.)

**Validates: Requirements 1.2, 2.3**

### Property 15: Location prioritisation orders by tier then match quality

*For any* set of locations, the normalised, prioritised order produced by the Location Service is non-decreasing by priority tier (tier 1 train/metro stations, tier 2 ferry, tier 3 bus, tier 4 other transit incl. light rail/coach/school, tier 5 address/POI/suburb), and for any two results sharing the same tier the earlier one has a `matchQuality` greater than or equal to the later one.

**Validates: Requirements 1.3, 1.4**

### Property 16: Mode-exclusion mapping emits the complement of included modes

*For any* non-empty subset S of the seven selectable Transport_Modes chosen for inclusion, the `TfnswClient.trip` request emits an `exclMOT_<code>=1` flag for exactly the modes in the complement of S (and none for modes in S); and when S is empty or equals the full set of selectable modes, the request emits no `excludedMeans`/`exclMOT_*` exclusion parameters at all.

**Validates: Requirements 6.2, 6.3**

## Error Handling

The system distinguishes recoverable user-facing conditions from upstream failures, and maps each to a clear client response.

| Condition | Detection | Client-facing behavior | Requirement |
|---|---|---|---|
| Query < 3 chars | Frontend guard + backend validation | No API call; results cleared | 1.6 |
| No matching locations | Empty normalised list | "No locations found for the given query" | 1.4 |
| TfNSW unreachable / error (search) | HTTP error / timeout from client | "Service temporarily unavailable"; typed text retained | 1.5 |
| Origin == destination | Backend validation before API call | Validation message; search prevented | 2.5 |
| All Transport_Modes deselected | Frontend guard + backend validation (empty included-modes set) | "At least one Transport_Mode is required"; search prevented, no API call | 6.4 |
| No routes available | Empty normalised journeys | "No routes found" + suggest changing origin/destination/time | 2.4 |
| TfNSW unreachable / error (route) | HTTP error / timeout from client | "Service temporarily unavailable"; selections retained | 2.6 |
| Route/journey detail retrieval fails | HTTP error / timeout on the `/api/routes` request (detail is part of this response, not fetched separately) | "Journey details could not be loaded" + retry action | 3.4 |
| Fare unpriceable for a journey | Null `totalFare` after fare estimation | Excluded from economical ranking; "fare estimate not available" shown | 4.4 |
| Fare missing for fastest in comparison | `fareUnavailableForFastest` flag | Notice shown; compare on time + transfers only | 5.6 |

### Error Model

- The backend defines typed errors: `ValidationError` (400) and `ServiceUnavailableError` (502/503 for upstream failures). Because journeys are not fetched by id, there is no journey `NotFoundError`; a failure to produce journey detail is part of the `/api/routes` request outcome (Req 3.4).
- Upstream calls use bounded timeouts (search ≤ 3s budget, route ≤ 5s budget) and a single short retry with backoff on transient network errors before surfacing `ServiceUnavailableError`.
- Error responses use a consistent JSON envelope `{ "error": { "code": string, "message": string } }`. The TfNSW API key and raw upstream payloads are never included in error responses or logs.

## Caching Strategy

Caching reduces latency, smooths the TfNSW rate limit, and improves the experience for both web and the future Android client.

- **Stop Finder responses**: cached keyed by normalised (lowercased, trimmed) query string. Location data changes infrequently, so a TTL of ~24 hours is appropriate.
- **Trip responses**: cached keyed by `(originId, destinationId, depArr, includedModesSignature, time-bucket)` with a short TTL (~60 seconds), because schedules and the implicit "now" change quickly. The `includedModesSignature` is a canonical (sorted) representation of the included-modes set so different mode selections do not collide, and `depArr` distinguishes depart-at from arrive-by windows. Requests without an explicit time round the time to a small bucket to improve hit rate while staying current.
- **Cache placement**: in the backend service layer (in-memory LRU for a single instance; a shared cache such as Redis if horizontally scaled). Clients receive `Cache-Control` headers so the SPA may also do brief client-side caching of autocomplete results.
- **Invalidation**: TTL-based expiry only; no manual invalidation needed for read-only proxied data.

## Security

- **API key protection (primary driver)**: The TfNSW API key is stored in a backend secret store / environment variable and injected into the `Authorization: apikey <key>` header by the `TfnswClient` only. It is never sent to clients, never embedded in frontend bundles, and never written to logs or error responses. This is the central reason the architecture uses a backend proxy rather than calling TfNSW directly from the browser.
- **Unauthenticated public endpoints (flagged decision)**: The `/api/locations` and `/api/routes` endpoints require **no end-user authentication** because the product has no user accounts or per-user data. This is an intentional design decision, not an omission. Because these endpoints proxy a keyed, rate-limited third-party API, they MUST be protected against abuse by:
  - **Rate limiting** per client IP (and an overall global ceiling) to protect the shared TfNSW quota.
  - **Strict input validation**: query length bounds, allowlisted parameters, and validated location-id and ISO time formats to prevent injection and malformed upstream calls.
  - **CORS** restricted to the known web origin(s).
- **Transport security**: All client-backend and backend-TfNSW traffic uses HTTPS.
- **No PII**: The system stores no personal data; requests carry only location ids and times. Logs record request metadata without secrets or full upstream payloads.
- **Untrusted upstream data**: EFA responses are treated as untrusted input — the normaliser validates and coerces fields rather than trusting structure, and output is encoded safely by the frontend to prevent injection via location names.

## Testing Strategy

A dual approach combines property-based tests for universal logic with example/edge/integration tests for specific behaviors and external boundaries.

### Property-Based Tests

- **Library**: a mature PBT library for the implementation language (e.g. `fast-check` for TypeScript, `Hypothesis` for Python). Property-based testing is NOT implemented from scratch.
- **Iterations**: each property test runs a minimum of **100 iterations**.
- **Traceability**: each property test is tagged with a comment referencing its design property, in the format:
  `Feature: tfnsw-route-planner, Property {number}: {property_text}`
- **Coverage**: Properties 1–16 above are each implemented by a single property-based test. Generators produce randomised journeys (varying leg counts, modes, times, transfer counts, and fares including missing-fare cases), forward/earlier journey-set pairs with overlapping signatures (for the merge window, Property 4), location lists (varying sizes including > 10, with varied types and served modes including multi-mode and non-transit, for prioritisation Property 15), included-mode subsets over the seven selectable modes (for the exclusion mapping, Property 16), and query strings (including whitespace-only and sub-3-character inputs).
- **Edge cases via generators**: empty/whitespace queries, journeys with a single leg, walk-only journeys with no fare, ties on travel time and on fare, large result sets (to exercise the caps), and non-ASCII location names are produced by the generators so the relevant properties cover them.

### Example-Based Unit Tests

Focused tests for behaviors that are not universal:
- Selecting a location stores it in the originating field (Req 1.3).
- Empty location result renders the "no locations found" message (Req 1.4).
- Route search enable/disable based on origin/destination selection (Req 2.1).
- Empty route result renders the "no routes found" + suggestion message (Req 2.4).
- Detail views render leg info including platform when present (Req 3.2, 4.2, 5.5).
- Opal Fare Calculator distance-band boundaries: each mode's exact band boundaries map to the correct fare value (e.g. a distance just below vs just above a band edge yields the adjacent fares), and walk/bicycle legs return null (Req 4.3).
- Comparison view renders both entries side by side (Req 5.1).
- Mode Selection control defaults to all seven modes selected (Req 6.1, 6.2).
- Time Filter control offers the three options and defaults to "Leave now" (Req 7.1, 7.2).
- Time filter to query mapping: "Leave now" / "Leave at" map to `depArr='dep'`, "Arrive by" maps to `depArr='arr'` (Req 7.3, 7.4, 7.5).

### Edge-Case / Error Tests

- Upstream failure during search surfaces `ServiceUnavailableError` and the SPA retains typed text (Req 1.5).
- Upstream failure during route search retains selections (Req 2.6).
- Journey detail fetch failure shows the error and exposes a retry action (Req 3.4). Since detail is part of the `/api/routes` response, this is exercised by failing that request.
- Deselecting all Transport_Modes raises a `ValidationError`, shows the "at least one Transport_Mode is required" message, and performs no upstream trip query (Req 6.4).

### Integration Tests

A small number (1–3 examples) verifying the real wiring, not run at scale:
- The `TfnswClient` sends the `Authorization` header and parses a recorded real EFA stop-finder and trip response into domain models, including computing per-leg Opal fare estimates from leg distance and mode.
- The performance budgets (3s search, 5s route) are checked against the live/recorded endpoint as smoke-level assertions.
- Rate limiting rejects requests exceeding the configured threshold.

### Frontend / Responsive Tests

- Snapshot and responsive-layout tests confirm mobile-first breakpoints render correctly across phone and desktop widths, including the Time Filter and Mode Selection controls. (UI rendering is validated by snapshot/example tests rather than property-based tests.)
