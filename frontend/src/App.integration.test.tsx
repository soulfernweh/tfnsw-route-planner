// @vitest-environment jsdom
//
// Happy-path integration test for the wired SPA (Task 12.2).
//
// This is an end-to-end *smoke* test of the full frontend flow against a MOCKED
// backend:
//
//   search (origin) -> search (destination) -> route discovery ->
//   ranking/comparison -> leg-by-leg detail
//
// App.tsx wires two `LocationSearchField` instances, a `RouteSearchController`
// (which renders `RouteList`), a `RouteComparisonView`, and a
// `JourneyDetailView`. None of these take an injected client from App: they all
// reach for the shared `apiClient` singleton exported by `./api/client`. We
// therefore mock that whole module once, so every component transitively uses
// our fake `searchLocations` / `planRoutes`. App's public shape is untouched.
//
// We use REAL timers (mirroring LocationSearchField.test.tsx): React Testing
// Library's async helpers poll on real timers, so they cooperate with the
// field's debounce. Selections are driven via the same native-event approach
// the component listens for (`mousedown` on options, `click` on buttons).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Location, RouteResult } from './api/types';

// --- Mock the shared API client module -------------------------------------
//
// `vi.hoisted` lets us define the mock fns before the (hoisted) `vi.mock`
// factory runs, and still reference them from the tests below.
const { searchLocationsMock, planRoutesMock } = vi.hoisted(() => ({
  searchLocationsMock: vi.fn(),
  planRoutesMock: vi.fn(),
}));

vi.mock('./api/client', () => {
  // A minimal stand-in for ApiError so the module's named export still exists.
  class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }
  // Both the `apiClient` singleton and any `new ApiClient()` resolve to the
  // same fake methods, so it does not matter which a component reaches for.
  class ApiClient {
    searchLocations = searchLocationsMock;
    planRoutes = planRoutesMock;
  }
  const apiClient = {
    searchLocations: searchLocationsMock,
    planRoutes: planRoutesMock,
  };
  // App imports the canonical selectable-mode list from this module to seed its
  // default mode selection, so the mock must re-export it.
  const ALL_SELECTABLE_MODES = [
    'train',
    'metro',
    'lightRail',
    'bus',
    'coach',
    'ferry',
    'school',
  ] as const;
  return { ApiClient, ApiError, apiClient, ALL_SELECTABLE_MODES };
});

// App must be imported AFTER vi.mock so its component tree binds to the mock.
import { App } from './App';

// --- Fixtures --------------------------------------------------------------

const TOWN_HALL: Location = {
  id: 'loc-town-hall',
  name: 'Town Hall Station',
  type: 'station',
  suburb: 'Sydney',
  modes: ['train'],
  matchQuality: 950,
  coord: { lat: -33.873, lng: 151.207 },
};

const WYNYARD: Location = {
  id: 'loc-wynyard',
  name: 'Wynyard Station',
  type: 'station',
  suburb: 'Sydney',
  modes: ['train'],
  matchQuality: 900,
  coord: { lat: -33.866, lng: 151.206 },
};

const CENTRAL: Location = {
  id: 'loc-central',
  name: 'Central Station',
  type: 'station',
  suburb: 'Haymarket',
  modes: ['train', 'metro'],
  matchQuality: 1000,
  coord: { lat: -33.883, lng: 151.206 },
};

const REDFERN: Location = {
  id: 'loc-redfern',
  name: 'Redfern Station',
  type: 'station',
  suburb: 'Redfern',
  modes: ['train'],
  matchQuality: 880,
  coord: { lat: -33.892, lng: 151.198 },
};

/**
 * A realistic two-journey result: a fastest train trip and a slower-but-cheaper
 * (economical) two-leg bus trip, both fully priced.
 */
const ROUTE_RESULT: RouteResult = {
  journeys: [
    {
      id: 'j-fast',
      legs: [
        {
          origin: {
            locationName: 'Town Hall Station',
            platform: '4',
            time: '2024-01-01T08:00:00Z',
          },
          destination: {
            locationName: 'Redfern Station',
            platform: '2',
            time: '2024-01-01T08:30:00Z',
          },
          mode: 'train',
          routeName: 'T1 North Shore Line',
          departureTime: '2024-01-01T08:00:00Z',
          arrivalTime: '2024-01-01T08:30:00Z',
          durationMinutes: 30,
          isTransfer: false,
          fare: { amountCents: 720, currency: 'AUD' },
        },
      ],
      departureTime: '2024-01-01T08:00:00Z',
      arrivalTime: '2024-01-01T08:30:00Z',
      travelTimeMinutes: 30,
      transferCount: 0,
      modes: ['train'],
      totalFare: { amountCents: 720, currency: 'AUD' },
    },
    {
      id: 'j-eco',
      legs: [
        {
          origin: {
            locationName: 'Town Hall Station',
            platform: '1',
            time: '2024-01-01T08:05:00Z',
          },
          destination: {
            locationName: 'Broadway Interchange',
            platform: null,
            time: '2024-01-01T08:25:00Z',
          },
          mode: 'bus',
          routeName: '370',
          departureTime: '2024-01-01T08:05:00Z',
          arrivalTime: '2024-01-01T08:25:00Z',
          durationMinutes: 20,
          isTransfer: false,
          fare: { amountCents: 250, currency: 'AUD' },
        },
        {
          origin: {
            locationName: 'Broadway Interchange',
            platform: null,
            time: '2024-01-01T08:30:00Z',
          },
          destination: {
            locationName: 'Redfern Station',
            platform: '3',
            time: '2024-01-01T08:50:00Z',
          },
          mode: 'bus',
          routeName: '352',
          departureTime: '2024-01-01T08:30:00Z',
          arrivalTime: '2024-01-01T08:50:00Z',
          durationMinutes: 20,
          isTransfer: false,
          fare: { amountCents: 210, currency: 'AUD' },
        },
      ],
      departureTime: '2024-01-01T08:05:00Z',
      arrivalTime: '2024-01-01T08:50:00Z',
      travelTimeMinutes: 45,
      transferCount: 1,
      modes: ['bus'],
      totalFare: { amountCents: 460, currency: 'AUD' },
    },
  ],
  fastestId: 'j-fast',
  economicalId: 'j-eco',
  comparison: {
    fastest: {
      journeyId: 'j-fast',
      travelTimeMinutes: 30,
      totalFare: { amountCents: 720, currency: 'AUD' },
      transferCount: 0,
      modes: ['train'],
    },
    economical: {
      journeyId: 'j-eco',
      travelTimeMinutes: 45,
      totalFare: { amountCents: 460, currency: 'AUD' },
      transferCount: 1,
      modes: ['bus'],
    },
    sameRoute: false,
    travelTimeDifferenceMinutes: 15,
    fareDifferenceCents: 260,
    fasterRouteId: 'j-fast',
    cheaperRouteId: 'j-eco',
    fareUnavailableForFastest: false,
  },
};

// --- Helpers ---------------------------------------------------------------

/** Sets an input's value through the native setter so React's onChange fires. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Types a query into the named field and selects the option with `optionName`. */
async function searchAndSelect(
  fieldLabel: string,
  query: string,
  optionName: string,
): Promise<void> {
  const input = screen.getByLabelText(fieldLabel) as HTMLInputElement;
  typeInto(input, query);

  // The field debounces (~300ms) before the listbox of results appears.
  const listbox = await screen.findByRole(
    'listbox',
    {},
    { timeout: 3000 },
  );
  const option = within(listbox).getByText(optionName);

  // The component selects on mousedown (before the input blurs).
  fireEvent.mouseDown(option);
}

// --- Setup -----------------------------------------------------------------

beforeEach(() => {
  searchLocationsMock.mockImplementation(async (query: string) => {
    const q = query.trim().toLowerCase();
    if (q.startsWith('tow')) {
      return [TOWN_HALL, WYNYARD];
    }
    if (q.startsWith('red')) {
      return [REDFERN, CENTRAL];
    }
    return [];
  });
  planRoutesMock.mockResolvedValue(ROUTE_RESULT);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// --- Test ------------------------------------------------------------------

describe('App happy-path integration', () => {
  it('drives search -> results -> comparison -> detail against a mocked backend', async () => {
    render(<App />);

    // Step 1 + 2: choose an origin and a (different) destination via the fields.
    await searchAndSelect('Origin', 'Town', TOWN_HALL.name);
    await searchAndSelect('Destination', 'Redfern', REDFERN.name);

    expect(searchLocationsMock).toHaveBeenCalled();

    // Step 3: trigger the route search and assert the list + comparison render.
    const findRoutes = screen.getByRole('button', { name: 'Find routes' });
    expect(findRoutes.hasAttribute('disabled')).toBe(false);
    fireEvent.click(findRoutes);

    // planRoutes is called with the two selected location ids (Req 2.2).
    await vi.waitFor(() => {
      expect(planRoutesMock).toHaveBeenCalledTimes(1);
    });
    expect(planRoutesMock.mock.calls[0]?.[0]).toMatchObject({
      originId: TOWN_HALL.id,
      destinationId: REDFERN.id,
    });

    // RouteList renders both discovered journeys (Req 2.2).
    const routeList = await screen.findByRole('list', {
      name: 'Available routes',
    });
    expect(within(routeList).getAllByRole('listitem')).toHaveLength(2);

    // RouteComparisonView shows fastest vs economical side by side (Req 5.1).
    const comparison = screen.getByRole('region', { name: 'Route comparison' });
    expect(within(comparison).getByText('Fastest route')).toBeTruthy();
    expect(within(comparison).getByText('Most economical route')).toBeTruthy();

    // Detail view is still in its empty/prompt state before a selection.
    const detailBefore = screen.getByRole('region', {
      name: 'Journey details',
    });
    expect(
      within(detailBefore).getByText(/Select a route to see its full details/i),
    ).toBeTruthy();

    // Step 4: select the economical route from the comparison view.
    const economicalCard = within(comparison).getByRole('button', {
      name: /Most economical route/,
    });
    fireEvent.click(economicalCard);

    // JourneyDetailView renders the leg-by-leg detail for the chosen journey
    // (Req 5.5) including estimated fares because it is the economical pick
    // (Req 4.2).
    const detail = screen.getByRole('region', { name: 'Journey details' });
    const legs = within(detail).getByRole('list', { name: 'Journey legs' });
    // Two bus legs render in the timeline.
    expect(within(legs).getAllByRole('listitem')).toHaveLength(2);

    // Leg endpoints are shown.
    expect(within(detail).getAllByText('Town Hall Station').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText('Broadway Interchange').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText('Redfern Station').length).toBeGreaterThan(0);

    // Per-leg estimated fares ($2.50, $2.10) and the total ($4.60) are shown.
    expect(within(detail).getByText(/\$2\.50/)).toBeTruthy();
    expect(within(detail).getByText(/\$2\.10/)).toBeTruthy();
    expect(within(detail).getByText(/\$4\.60/)).toBeTruthy();
  });
});
