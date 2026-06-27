// @vitest-environment jsdom
//
// Unit tests for RouteSearchController (task 11.5).
//
// Covers:
//   - The search action is disabled until BOTH an origin and a destination are
//     selected, and they differ (Req 2.1).
//   - When origin and destination are the SAME location, a validation message
//     is shown and the search is prevented (Req 2.5).
//   - An empty route result renders the "no routes found" + suggestion message
//     (Req 2.4).
//
// The ApiClient is faked via the injectable `client` prop (a stub `planRoutes`),
// so these tests exercise the component in isolation with no real network.
//
// Note: a per-file `@vitest-environment jsdom` docblock (above) is used instead
// of editing the shared vitest config, so this file is self-contained.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import type { ApiClient } from '../api/client';
import type { Location, RouteResult, SelectableMode } from '../api/types';
import { RouteSearchController } from './RouteSearchController';
import { NO_MODES_MESSAGE } from './ModeSelectionControl';

afterEach(() => {
  cleanup();
});

/** Builds a Location with sensible defaults for tests. */
function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    id: 'loc-1',
    name: 'Central Station',
    type: 'station',
    suburb: 'Sydney',
    modes: ['train'],
    matchQuality: 1000,
    coord: { lat: -33.8832, lng: 151.2069 },
    ...overrides,
  };
}

/** An empty (but well-formed) route result, driving the "no routes" state. */
const EMPTY_RESULT: RouteResult = {
  journeys: [],
  fastestId: null,
  economicalId: null,
  comparison: {
    fastest: null,
    economical: null,
    sameRoute: false,
    travelTimeDifferenceMinutes: null,
    fareDifferenceCents: null,
    fasterRouteId: null,
    cheaperRouteId: null,
    fareUnavailableForFastest: false,
  },
};

/**
 * Builds a fake ApiClient exposing only `planRoutes`, cast to the ApiClient
 * type. The returned spy lets tests assert whether the backend was invoked.
 */
function makeFakeClient(
  planRoutes: ApiClient['planRoutes'],
): { client: ApiClient; planRoutes: typeof planRoutes } {
  const spy = vi.fn(planRoutes) as unknown as ApiClient['planRoutes'];
  const client = { planRoutes: spy } as unknown as ApiClient;
  return { client, planRoutes: spy };
}

/** Returns the "Find routes" action button. */
function findRoutesButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /find routes/i }) as HTMLButtonElement;
}

describe('RouteSearchController search enable/disable (Req 2.1)', () => {
  it('disables the search action when neither origin nor destination is selected', () => {
    const { client } = makeFakeClient(async () => EMPTY_RESULT);
    render(
      <RouteSearchController origin={null} destination={null} client={client} />,
    );

    expect(findRoutesButton()).toBeDisabled();
  });

  it('keeps the search action disabled when only the origin is selected', () => {
    const { client } = makeFakeClient(async () => EMPTY_RESULT);
    render(
      <RouteSearchController
        origin={makeLocation({ id: 'origin' })}
        destination={null}
        client={client}
      />,
    );

    expect(findRoutesButton()).toBeDisabled();
  });

  it('keeps the search action disabled when only the destination is selected', () => {
    const { client } = makeFakeClient(async () => EMPTY_RESULT);
    render(
      <RouteSearchController
        origin={null}
        destination={makeLocation({ id: 'destination' })}
        client={client}
      />,
    );

    expect(findRoutesButton()).toBeDisabled();
  });

  it('enables the search action once both a distinct origin and destination are selected', () => {
    const { client } = makeFakeClient(async () => EMPTY_RESULT);
    render(
      <RouteSearchController
        origin={makeLocation({ id: 'origin', name: 'Town Hall' })}
        destination={makeLocation({ id: 'destination', name: 'Bondi Junction' })}
        client={client}
      />,
    );

    expect(findRoutesButton()).toBeEnabled();
  });
});

describe('RouteSearchController same-location validation (Req 2.5)', () => {
  it('shows a validation message and prevents the search when origin and destination are the same location', () => {
    const sameId = 'loc-same';
    const { client, planRoutes } = makeFakeClient(async () => EMPTY_RESULT);
    render(
      <RouteSearchController
        origin={makeLocation({ id: sameId, name: 'Central Station' })}
        destination={makeLocation({ id: sameId, name: 'Central Station' })}
        client={client}
      />,
    );

    // A same-location validation message is surfaced to the user.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/cannot be the same/i);

    // The search action is disabled, so the search is prevented...
    const button = findRoutesButton();
    expect(button).toBeDisabled();

    // ...and attempting to activate it never reaches the backend.
    fireEvent.click(button);
    expect(planRoutes).not.toHaveBeenCalled();
  });
});

describe('RouteSearchController empty route result (Req 2.4)', () => {
  it('renders the "no routes found" message with a suggestion when the search returns no journeys', async () => {
    const { client, planRoutes } = makeFakeClient(async () => EMPTY_RESULT);
    render(
      <RouteSearchController
        origin={makeLocation({ id: 'origin', name: 'Town Hall' })}
        destination={makeLocation({ id: 'destination', name: 'Bondi Junction' })}
        client={client}
      />,
    );

    fireEvent.click(findRoutesButton());

    // The empty-state message appears and suggests changing the inputs.
    const message = await screen.findByText(/no routes found/i);
    expect(message).toBeInTheDocument();
    // The suggestion mentions changing the origin, destination, and time.
    const text = message.textContent ?? '';
    expect(text).toMatch(/chang/i);
    expect(text).toMatch(/origin/i);
    expect(text).toMatch(/destination/i);
    expect(text).toMatch(/time/i);

    // The backend was queried exactly once for the valid pair.
    expect(planRoutes).toHaveBeenCalledTimes(1);
  });
});

describe('RouteSearchController mode-selection validation (Req 6.4)', () => {
  it('blocks the search and shows the no-modes message when zero modes are included', () => {
    const { client, planRoutes } = makeFakeClient(async () => EMPTY_RESULT);
    const noModes: SelectableMode[] = [];
    render(
      <RouteSearchController
        origin={makeLocation({ id: 'origin', name: 'Town Hall' })}
        destination={makeLocation({ id: 'destination', name: 'Bondi Junction' })}
        includedModes={noModes}
        client={client}
      />,
    );

    // The no-modes validation message is surfaced to the user.
    expect(screen.getByText(NO_MODES_MESSAGE)).toBeInTheDocument();

    // The search action is disabled even though a valid origin/destination
    // pair is selected, so the search is prevented...
    const button = findRoutesButton();
    expect(button).toBeDisabled();

    // ...and attempting to activate it never reaches the backend.
    fireEvent.click(button);
    expect(planRoutes).not.toHaveBeenCalled();
  });

  it('enables the search and forwards the selected modes when a non-empty subset is included', async () => {
    const { client, planRoutes } = makeFakeClient(async () => EMPTY_RESULT);
    const someModes: SelectableMode[] = ['train', 'bus'];
    render(
      <RouteSearchController
        origin={makeLocation({ id: 'origin', name: 'Town Hall' })}
        destination={makeLocation({ id: 'destination', name: 'Bondi Junction' })}
        includedModes={someModes}
        client={client}
      />,
    );

    const button = findRoutesButton();
    expect(button).toBeEnabled();

    fireEvent.click(button);

    await screen.findByText(/no routes found/i);
    expect(planRoutes).toHaveBeenCalledTimes(1);
    expect(planRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ modes: someModes }),
      expect.anything(),
    );
  });
});
