// RouteSearchController — gates and runs the route search, then renders results.
//
// Responsibilities (Requirements 2.1, 2.4, 2.5, 2.6, plus 2.2/2.3/3.1/4.1 via
// RouteList):
//   - Enables the search action only when both an origin and a destination are
//     selected AND they are different locations (Req 2.1).
//   - When origin and destination are the same, shows a same-location
//     validation message and prevents the search (Req 2.5).
//   - Calls the backend through the existing ApiClient.planRoutes.
//   - On upstream failure, retains the user's selected origin/destination
//     (these are owned by the parent and passed as props, so they persist) and
//     shows a "service temporarily unavailable" message (Req 2.6).
//   - When the search returns no journeys, shows a "no routes found" message
//     and suggests changing the origin, destination, or time (Req 2.4).
//
// The origin/destination selections themselves are produced by
// LocationSearchField (task 11.2) and passed in as props; this component never
// owns or mutates them, so a failed search cannot lose them.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient, apiClient as sharedApiClient } from '../api/client';
import type { WhenFilter } from '../api/client';
import type { Journey, Location, RouteResult, SelectableMode } from '../api/types';
import { RouteList } from './RouteList';
import { NO_MODES_MESSAGE } from './ModeSelectionControl';
import '../styles/routes.css';

export interface RouteSearchControllerProps {
  /** The selected origin location, or null if not yet chosen. */
  origin: Location | null;
  /** The selected destination location, or null if not yet chosen. */
  destination: Location | null;
  /** ISO 8601 desired departure/arrival time. Optional; backend defaults to "now". */
  time?: string;
  /**
   * The Time_Filter (Req 7). Defaults to 'leaveNow' when omitted; passed
   * straight through to `planRoutes`.
   */
  when?: WhenFilter;
  /**
   * The user's selected transport modes (Req 6). When provided and empty, the
   * search is blocked and the "at least one transport mode is required"
   * validation message is shown (Req 6.4). When undefined, no mode filter is
   * applied (all modes included).
   */
  includedModes?: SelectableMode[];
  /** API client override (defaults to the shared client). */
  client?: ApiClient;
  /** Invoked when the user selects a route to view its details (task 11.6). */
  onSelectJourney?: (journey: Journey) => void;
  /**
   * Surfaces the latest route result to the parent so it can render the
   * comparison and detail views from the already-fetched journeys. Receives the
   * `RouteResult` on a successful search, or `null` while idle/loading or after
   * a failure (so the parent can clear any stale comparison/detail).
   */
  onResult?: (result: RouteResult | null) => void;
  /**
   * Monotonically-increasing retry signal. Whenever this value changes, the
   * controller re-runs the current search. The parent wires this to the
   * JourneyDetailView retry action (Req 3.4).
   */
  retrySignal?: number;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; result: RouteResult }
  | { status: 'error'; message: string };

const SERVICE_UNAVAILABLE_MESSAGE =
  'Service temporarily unavailable. Please try again in a moment.';

/** True when both endpoints are chosen and they are different locations. */
function canSearch(origin: Location | null, destination: Location | null): boolean {
  return (
    origin !== null && destination !== null && origin.id !== destination.id
  );
}

/** True when both endpoints are chosen but resolve to the same location. */
function isSameLocation(
  origin: Location | null,
  destination: Location | null,
): boolean {
  return origin !== null && destination !== null && origin.id === destination.id;
}

export function RouteSearchController({
  origin,
  destination,
  time,
  when,
  includedModes,
  client,
  onSelectJourney,
  onResult,
  retrySignal,
}: RouteSearchControllerProps): JSX.Element {
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const activeClient = client ?? sharedApiClient;
  const abortRef = useRef<AbortController | null>(null);

  const searchEnabled = canSearch(origin, destination);
  const sameLocation = isSameLocation(origin, destination);
  // Req 6.4: an explicit, empty mode selection blocks the search.
  const noModesSelected =
    includedModes !== undefined && includedModes.length === 0;

  const runSearch = useCallback(async () => {
    if (!origin || !destination || origin.id === destination.id) {
      // Guard: never call the backend for an invalid pair (Req 2.5).
      return;
    }
    if (includedModes !== undefined && includedModes.length === 0) {
      // Req 6.4: do not search when every transport mode is deselected.
      return;
    }

    // Cancel any in-flight request so results never arrive out of order.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ status: 'loading' });
    try {
      const result = await activeClient.planRoutes(
        {
          originId: origin.id,
          destinationId: destination.id,
          ...(time !== undefined ? { time } : {}),
          ...(when !== undefined ? { when } : {}),
          ...(includedModes !== undefined ? { modes: includedModes } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      setState({ status: 'success', result });
    } catch {
      if (controller.signal.aborted) {
        return;
      }
      // Upstream/transport failure. Selections are owned by the parent and are
      // left untouched, so they are retained for the user (Req 2.6).
      setState({ status: 'error', message: SERVICE_UNAVAILABLE_MESSAGE });
    }
  }, [origin, destination, time, when, includedModes, activeClient]);

  // Surface the latest result (or null) to the parent so it can render the
  // comparison and detail views from the already-fetched journeys (Req 5.1,
  // 5.5). On loading/error/idle we pass null so any stale views are cleared.
  useEffect(() => {
    if (!onResult) {
      return;
    }
    onResult(state.status === 'success' ? state.result : null);
  }, [state, onResult]);

  // Re-run the current search whenever the parent bumps the retry signal. This
  // backs the JourneyDetailView retry action (Req 3.4). The initial render is
  // skipped so mounting never triggers an unsolicited search.
  const lastRetryRef = useRef<number | undefined>(retrySignal);
  useEffect(() => {
    if (retrySignal === undefined || lastRetryRef.current === retrySignal) {
      return;
    }
    lastRetryRef.current = retrySignal;
    void runSearch();
  }, [retrySignal, runSearch]);

  const showNoResults =
    state.status === 'success' && state.result.journeys.length === 0;
  const showResults =
    state.status === 'success' && state.result.journeys.length > 0;

  return (
    <div className="route-search">
      <div className="route-search__actions">
        <button
          type="button"
          className="route-search__button"
          onClick={runSearch}
          disabled={!searchEnabled || noModesSelected || state.status === 'loading'}
          aria-disabled={!searchEnabled || noModesSelected || state.status === 'loading'}
        >
          {state.status === 'loading' ? 'Searching…' : 'Find routes'}
        </button>
      </div>

      {sameLocation && (
        <p className="route-search__message route-search__message--validation" role="alert">
          Origin and destination cannot be the same. Choose a different
          destination.
        </p>
      )}

      {noModesSelected && (
        <p className="route-search__message route-search__message--validation" role="alert">
          {NO_MODES_MESSAGE}
        </p>
      )}

      {state.status === 'loading' && (
        <p className="route-search__message" role="status">
          Finding routes…
        </p>
      )}

      {state.status === 'error' && (
        <p className="route-search__message route-search__message--error" role="alert">
          {state.message}
        </p>
      )}

      {showNoResults && (
        <p className="route-search__message route-search__message--empty" role="status">
          No routes found. Try changing your origin, destination, or departure
          time.
        </p>
      )}

      {showResults && (
        <RouteList
          journeys={state.result.journeys}
          fastestId={state.result.fastestId}
          economicalId={state.result.economicalId}
          {...(onSelectJourney ? { onSelect: onSelectJourney } : {})}
        />
      )}
    </div>
  );
}
