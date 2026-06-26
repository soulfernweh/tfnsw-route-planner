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

import { useCallback, useRef, useState } from 'react';
import { ApiClient, apiClient as sharedApiClient } from '../api/client';
import type { Journey, Location, RouteResult } from '../api/types';
import { RouteList } from './RouteList';
import '../styles/routes.css';

export interface RouteSearchControllerProps {
  /** The selected origin location, or null if not yet chosen. */
  origin: Location | null;
  /** The selected destination location, or null if not yet chosen. */
  destination: Location | null;
  /** ISO 8601 desired departure time. Optional; backend defaults to "now". */
  time?: string;
  /** API client override (defaults to the shared client). */
  client?: ApiClient;
  /** Invoked when the user selects a route to view its details (task 11.6). */
  onSelectJourney?: (journey: Journey) => void;
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
  client,
  onSelectJourney,
}: RouteSearchControllerProps): JSX.Element {
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const activeClient = client ?? sharedApiClient;
  const abortRef = useRef<AbortController | null>(null);

  const searchEnabled = canSearch(origin, destination);
  const sameLocation = isSameLocation(origin, destination);

  const runSearch = useCallback(async () => {
    if (!origin || !destination || origin.id === destination.id) {
      // Guard: never call the backend for an invalid pair (Req 2.5).
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
  }, [origin, destination, time, activeClient]);

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
          disabled={!searchEnabled || state.status === 'loading'}
          aria-disabled={!searchEnabled || state.status === 'loading'}
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
