// Top-level app shell for the TfNSW Route Planner SPA.
//
// This wires the full frontend flow end to end (task 12.1):
//
//   search → route discovery → ranking/comparison → detail
//
// Data flow & ownership:
//   - App owns the selected origin/destination `Location` state. Because these
//     selections live here (not inside the search controller), they are
//     RETAINED across upstream failures and re-renders (Req 1.3, 2.6).
//   - Two `LocationSearchField` instances (origin + destination) surface their
//     chosen location back up via a shared `onSelect` handler keyed by fieldId.
//   - `RouteSearchController` gates the search on both endpoints being selected
//     AND different (Req 2.1, 2.5), calls `planRoutes`, renders the `RouteList`,
//     and surfaces the resulting `RouteResult` back to App via `onResult`.
//   - From the result, App renders `RouteComparisonView` (fastest vs economical,
//     Req 5.1) and `JourneyDetailView` for whichever route the user selects from
//     either the list or the comparison (Req 5.5). The detail view renders from
//     the already-fetched `Journey` object — there is no separate detail fetch.
//   - `JourneyDetailView`'s retry action re-triggers the route search via a
//     monotonic retry signal handed to the controller (Req 3.4).
//
// Mobile-first/responsive: the existing app-shell layout stacks the search and
// results regions on phones and places them side by side from the desktop
// breakpoint up, giving a master (search + list) / detail (comparison + detail)
// layout on wide screens.

import { useCallback, useState } from 'react';
import { LocationSearchField } from './components/LocationSearchField';
import { RouteSearchController } from './components/RouteSearchController';
import { RouteComparisonView } from './components/RouteComparisonView';
import { JourneyDetailView } from './components/JourneyDetailView';
import { TimeFilterControl } from './components/TimeFilterControl';
import type { TimeFilterValue } from './components/TimeFilterControl';
import { ModeSelectionControl } from './components/ModeSelectionControl';
import { ALL_SELECTABLE_MODES } from './api/client';
import type {
  Journey,
  Location,
  RouteResult,
  SelectableMode,
} from './api/types';
import './styles/app.css';

/** Stable field identifiers shared by the origin/destination search fields. */
const ORIGIN_FIELD = 'origin';
const DESTINATION_FIELD = 'destination';

/** The application shell: header, responsive layout, and the wired flow. */
export function App(): JSX.Element {
  // Selected endpoints. Owned here so they survive search failures (Req 2.6).
  const [origin, setOrigin] = useState<Location | null>(null);
  const [destination, setDestination] = useState<Location | null>(null);

  // The latest successful route result (or null while idle/loading/error),
  // surfaced by the RouteSearchController.
  const [result, setResult] = useState<RouteResult | null>(null);

  // The Time_Filter state (Req 7). Defaults to "Leave now" with no explicit
  // time, mirroring the TimeFilterControl's initial state.
  const [timeFilter, setTimeFilter] = useState<TimeFilterValue>({
    when: 'leaveNow',
  });

  // The selected transport modes (Req 6). All seven are selected by default,
  // matching the ModeSelectionControl's initial state.
  const [includedModes, setIncludedModes] = useState<SelectableMode[]>(() => [
    ...ALL_SELECTABLE_MODES,
  ]);

  // The route the user has chosen to inspect in detail (from the list or the
  // comparison view).
  const [selectedJourney, setSelectedJourney] = useState<Journey | null>(null);

  // Bumped to ask the controller to re-run the current search (retry, Req 3.4).
  const [retrySignal, setRetrySignal] = useState<number>(0);

  // Timestamp of when the latest results were fetched (for the footer display).
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Route a field's selection to the correct endpoint (Req 1.3). Editing or
  // clearing a field surfaces `null`, which we store as-is.
  const handleSelectLocation = useCallback(
    (location: Location | null, fieldId: string): void => {
      if (fieldId === ORIGIN_FIELD) {
        setOrigin(location);
      } else if (fieldId === DESTINATION_FIELD) {
        setDestination(location);
      }
    },
    [],
  );

  // Receive the controller's result. A new result (including a null reset while
  // loading or after a failure) clears any previously selected journey so the
  // detail view never shows a route from a stale search.
  const handleResult = useCallback((next: RouteResult | null): void => {
    setResult(next);
    setSelectedJourney(null);
    if (next !== null) {
      setLastUpdated(new Date());
    }
  }, []);

  const handleSelectJourney = useCallback((journey: Journey): void => {
    setSelectedJourney(journey);
  }, []);

  // Re-trigger the route search (wired to the detail view's retry, Req 3.4).
  const handleRetry = useCallback((): void => {
    setRetrySignal((signal) => signal + 1);
  }, []);

  const handleTimeFilterChange = useCallback((next: TimeFilterValue): void => {
    setTimeFilter(next);
  }, []);

  const handleModesChange = useCallback((next: SelectableMode[]): void => {
    setIncludedModes(next);
  }, []);

  const hasRoutes = result !== null && result.journeys.length > 0;
  // Mark the detail view as the economical selection when the chosen journey is
  // the one the backend ranked most economical (drives per-leg/total fares).
  const selectedIsEconomical =
    selectedJourney !== null &&
    result !== null &&
    result.economicalId !== null &&
    selectedJourney.id === result.economicalId;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <div>
            <h1 className="app-header__title">TfNSW Route Planner</h1>
            {origin && destination && (
              <div className="app-header__summary">
                <span>{origin.name}</span>
                <span className="app-header__summary-arrow">→</span>
                <span>{destination.name}</span>
              </div>
            )}
            {!(origin && destination) && (
              <p className="app-header__subtitle">
                Find, compare, and choose the fastest or most economical trip.
              </p>
            )}
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-layout">
          <section
            className="app-region app-region--search"
            aria-label="Search"
          >
            <h2 className="app-region__heading">Plan a trip</h2>

            <div className="app-search-fields">
              <LocationSearchField
                fieldId={ORIGIN_FIELD}
                label="Origin"
                placeholder="Search for a start location"
                value={origin}
                onSelect={handleSelectLocation}
              />
              <LocationSearchField
                fieldId={DESTINATION_FIELD}
                label="Destination"
                placeholder="Search for a destination"
                value={destination}
                onSelect={handleSelectLocation}
              />
            </div>

            <div className="app-search-filters">
              <TimeFilterControl onChange={handleTimeFilterChange} />
              <ModeSelectionControl onChange={handleModesChange} />
            </div>

            <RouteSearchController
              origin={origin}
              destination={destination}
              when={timeFilter.when}
              {...(timeFilter.time !== undefined ? { time: timeFilter.time } : {})}
              includedModes={includedModes}
              onSelectJourney={handleSelectJourney}
              onResult={handleResult}
              retrySignal={retrySignal}
            />
          </section>

          <section
            className="app-region app-region--results"
            aria-label="Results"
          >
            <h2 className="app-region__heading">Routes</h2>

            {hasRoutes ? (
              <div className="app-results">
                <RouteComparisonView
                  comparison={result.comparison}
                  journeys={result.journeys}
                  onSelect={handleSelectJourney}
                />
                <JourneyDetailView
                  journey={selectedJourney}
                  isEconomical={selectedIsEconomical}
                  onRetry={handleRetry}
                />
              </div>
            ) : (
              <p className="app-placeholder">
                Route results and comparison will appear here once you search.
              </p>
            )}
          </section>
        </div>
      </main>

      <footer className="app-footer">
        {lastUpdated && (
          <span className="app-footer__updated">
            Real-time data updated at{' '}
            {lastUpdated.toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        )}
        <span>Powered by the Transport for NSW Open Data Trip Planner.</span>
      </footer>
    </div>
  );
}
