// @vitest-environment jsdom
//
// Unit tests for LocationSearchField behaviours (Task 11.3).
//
// These are example-based tests (per the design's Testing Strategy) covering
// the search-field behaviours that are NOT universal properties:
//   - Req 1.3: selecting a location stores it in the originating field, and the
//     parent is notified with the location AND the fieldId.
//   - Req 1.4: an empty result list renders the "no locations found" message.
//   - Req 1.5: an upstream failure renders the "service temporarily
//     unavailable" message while RETAINING the typed text.
//   - Req 1.6 (bonus): inputs shorter than the 3-character minimum never query
//     the API and clear any previously shown results.
//
// The ApiClient is mocked via the injectable `client` prop. A small injected
// debounce (`debounceMs`) keeps the async flow fast while still letting us
// assert that the query does not fire synchronously. We deliberately use REAL
// timers here: React Testing Library's async helpers (findBy*/waitFor) poll on
// real timers, so mixing them with fake timers deadlocks.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { Location } from '../api/types';
import {
  LocationSearchField,
  MESSAGES,
  MIN_QUERY_LENGTH,
  type LocationSearchFieldProps,
} from './LocationSearchField';

// --- Test fixtures ---------------------------------------------------------

const FIELD_ID = 'origin';

/** A short debounce keeps tests fast while preserving the debounce semantics. */
const TEST_DEBOUNCE_MS = 20;

const TOWN_HALL: Location = {
  id: 'stop-th',
  name: 'Town Hall Station',
  type: 'station',
  suburb: 'Sydney',
  modes: ['train'],
  matchQuality: 950,
  coord: { lat: -33.873, lng: 151.207 },
};

const CENTRAL: Location = {
  id: 'stop-central',
  name: 'Central Station',
  type: 'station',
  suburb: 'Haymarket',
  modes: ['train', 'metro'],
  matchQuality: 1000,
  coord: { lat: -33.883, lng: 151.206 },
};

/**
 * Builds a fake ApiClient whose `searchLocations` resolves/rejects on demand.
 * Only `searchLocations` is exercised by this component, so the rest of the
 * surface is cast to satisfy the type without unused stubs.
 */
function makeFakeClient(
  searchLocations: ApiClient['searchLocations'],
): ApiClient {
  return { searchLocations } as unknown as ApiClient;
}

/** Renders the field with sensible defaults, allowing per-test overrides. */
function renderField(
  overrides: Partial<LocationSearchFieldProps> & { client: ApiClient },
): { onSelect: ReturnType<typeof vi.fn> } {
  const onSelect =
    (overrides.onSelect as ReturnType<typeof vi.fn> | undefined) ?? vi.fn();
  const props: LocationSearchFieldProps = {
    fieldId: FIELD_ID,
    label: 'Origin',
    value: null,
    onSelect,
    debounceMs: TEST_DEBOUNCE_MS,
    ...overrides,
  };
  render(<LocationSearchField {...props} />);
  return { onSelect };
}

/** Types into the combobox input via a native input event. */
function typeQuery(value: string): HTMLInputElement {
  const input = screen.getByRole('combobox') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

// --- Setup -----------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- Tests -----------------------------------------------------------------

describe('LocationSearchField', () => {
  it('queries only after the debounce once the 3-char minimum is met (Req 1.1)', async () => {
    const searchLocations = vi.fn().mockResolvedValue([TOWN_HALL]);
    const client = makeFakeClient(searchLocations);
    renderField({ client });

    typeQuery('Tow');
    // The request must not fire synchronously, before the debounce window.
    expect(searchLocations).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(searchLocations).toHaveBeenCalledTimes(1);
    });
    expect(searchLocations).toHaveBeenCalledWith('Tow', expect.anything());
  });

  it('selecting a location stores it in the originating field (Req 1.3)', async () => {
    const searchLocations = vi.fn().mockResolvedValue([TOWN_HALL, CENTRAL]);
    const client = makeFakeClient(searchLocations);
    const { onSelect } = renderField({ client, fieldId: FIELD_ID });

    typeQuery('Town');

    const listbox = await screen.findByRole('listbox');
    const option = within(listbox).getByText(TOWN_HALL.name);

    // Selection fires on mousedown (before the input blurs).
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    // The parent is notified with BOTH the chosen location and the fieldId so a
    // shared handler can route it to the correct field.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(TOWN_HALL, FIELD_ID);

    // The field reflects the chosen location as its text value, and the list
    // collapses after a selection. Both follow from the post-selection state
    // update, so we wait for React to flush the re-render.
    const input = screen.getByRole('combobox') as HTMLInputElement;
    await waitFor(() => {
      expect(input.value).toBe(TOWN_HALL.name);
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('renders the "no locations found" message for an empty result list (Req 1.4)', async () => {
    const searchLocations = vi.fn().mockResolvedValue([]);
    const client = makeFakeClient(searchLocations);
    renderField({ client });

    typeQuery('Xyzzy');

    expect(await screen.findByText(MESSAGES.noResults)).toBeTruthy();
    // No results means no selectable listbox.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('renders the "service temporarily unavailable" message and RETAINS typed text on upstream failure (Req 1.5)', async () => {
    const searchLocations = vi
      .fn()
      .mockRejectedValue(new Error('upstream exploded'));
    const client = makeFakeClient(searchLocations);
    renderField({ client });

    const typed = 'Central';
    typeQuery(typed);

    expect(await screen.findByText(MESSAGES.serviceUnavailable)).toBeTruthy();

    // Req 1.5: the typed text is retained despite the failure.
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe(typed);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not query and clears results below the 3-char minimum (Req 1.6)', async () => {
    const searchLocations = vi.fn().mockResolvedValue([TOWN_HALL, CENTRAL]);
    const client = makeFakeClient(searchLocations);
    renderField({ client });

    // First, a valid query produces results.
    typeQuery('Town');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(searchLocations).toHaveBeenCalledTimes(1);

    // Now drop below the minimum: no new query and results are cleared.
    const shortQuery = 'To';
    expect(shortQuery.length).toBeLessThan(MIN_QUERY_LENGTH);
    typeQuery(shortQuery);

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    expect(searchLocations).toHaveBeenCalledTimes(1); // unchanged
    expect(screen.queryByText(MESSAGES.noResults)).toBeNull();
  });
});
