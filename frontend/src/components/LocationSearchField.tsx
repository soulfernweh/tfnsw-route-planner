// LocationSearchField — debounced location autocomplete (Requirement 1).
//
// A single component used for BOTH the origin and destination inputs. It owns
// the typed text and the result-list UI, and surfaces the chosen location to
// its parent via `onSelect`. All network access goes through the existing
// `ApiClient.searchLocations`, with stale requests cancelled via AbortSignal.
//
// Behaviour (Requirement 1):
//   1.1 / 1.6  Debounced query; only fires when the trimmed input is >= 3 chars.
//   1.6        When the input drops below 3 chars, previously shown results are
//              cleared and no request is made.
//   1.2        Up to 10 results render in a selectable listbox showing the
//              location name, type, and suburb.
//   1.3        Selecting a result stores it as the field value and surfaces the
//              selection to the parent.
//   1.4        Empty results render a "no locations found" message.
//   1.5        An API error renders a "service temporarily unavailable" message
//              while RETAINING the typed text.
//
// Accessibility: implements the ARIA combobox pattern (combobox input wired to
// a listbox of options) with keyboard navigation (Arrow keys, Enter, Escape).

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { apiClient, type ApiClient } from '../api/client';
import type { Location, LocationType } from '../api/types';
import './LocationSearchField.css';

/** Minimum trimmed query length before the API is queried (Req 1.1, 1.6). */
export const MIN_QUERY_LENGTH = 3;

/** Default debounce delay applied before issuing an autocomplete request. */
export const DEFAULT_DEBOUNCE_MS = 300;

/** Maximum number of results rendered in the list (Req 1.2). The backend also
 * caps at 10; this is a defensive presentation-side guard. */
const MAX_RESULTS = 10;

/** The transient state of the autocomplete dropdown. */
type SearchStatus = 'idle' | 'loading' | 'results' | 'empty' | 'error';

/** Human-readable labels for each location type, shown beside results. */
const LOCATION_TYPE_LABEL: Record<LocationType, string> = {
  stop: 'Stop',
  station: 'Station',
  platform: 'Platform',
  poi: 'Point of interest',
  address: 'Address',
  suburb: 'Suburb',
};

/** User-facing messages (kept here so tests and UI share one source). */
export const MESSAGES = {
  noResults: 'No locations found for the given query.',
  serviceUnavailable:
    'Location service is temporarily unavailable. Please try again.',
  loading: 'Searching locations…',
} as const;

/** Props for {@link LocationSearchField}. */
export interface LocationSearchFieldProps {
  /**
   * Stable identifier distinguishing the origin field from the destination
   * field (e.g. "origin" / "destination"). Used to derive element ids and to
   * let the parent know which field a selection came from.
   */
  fieldId: string;
  /** Visible label for the input (e.g. "Origin", "Destination"). */
  label: string;
  /**
   * The currently selected location, or null when none is chosen. The parent
   * owns this value; the field reflects it as the input text.
   */
  value: Location | null;
  /**
   * Called when the user selects a result (the {@link Location}) or clears the
   * field (null). The `fieldId` is echoed so a shared handler can route the
   * selection to the correct field (Req 1.3).
   */
  onSelect: (location: Location | null, fieldId: string) => void;
  /** Optional placeholder text for the empty input. */
  placeholder?: string;
  /** Debounce delay in milliseconds. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Injectable API client (defaults to the shared {@link apiClient}). */
  client?: ApiClient;
}

/**
 * Returns true when the AbortError was caused by us cancelling a stale request,
 * so we can ignore it rather than surface a spurious error state.
 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) ||
    (error instanceof Error && error.name === 'AbortError');
}

/**
 * A debounced, accessible location autocomplete field. See module header for
 * the full mapping to Requirement 1 acceptance criteria.
 */
export function LocationSearchField({
  fieldId,
  label,
  value,
  onSelect,
  placeholder,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  client = apiClient,
}: LocationSearchFieldProps): JSX.Element {
  // The text currently in the input. Initialised from any selected value so
  // the field reflects an externally-set selection.
  const [inputText, setInputText] = useState<string>(value?.name ?? '');
  const [results, setResults] = useState<Location[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [isOpen, setIsOpen] = useState<boolean>(false);
  // Index of the keyboard-highlighted option, or -1 when none is active.
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  // The controller for the in-flight request, so we can cancel stale ones.
  const abortRef = useRef<AbortController | null>(null);
  // When true, the next debounce cycle is skipped because the text change was
  // caused by selecting a result (not by the user typing a new query).
  const skipNextQueryRef = useRef<boolean>(false);

  const baseId = useId();
  const inputId = `${baseId}-${fieldId}-input`;
  const listboxId = `${baseId}-${fieldId}-listbox`;
  const statusId = `${baseId}-${fieldId}-status`;
  const optionId = (index: number): string => `${listboxId}-option-${index}`;

  // Keep the input text in sync if the parent replaces the selected value
  // (e.g. a "clear" button, or programmatic prefill).
  useEffect(() => {
    if (value) {
      skipNextQueryRef.current = true;
      setInputText(value.name);
      setResults([]);
      setStatus('idle');
      setIsOpen(false);
    }
  }, [value]);

  // Cancel any in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Debounced query effect. Re-runs whenever the typed text changes.
  useEffect(() => {
    // A selection just populated the text; don't treat it as a new query.
    if (skipNextQueryRef.current) {
      skipNextQueryRef.current = false;
      return;
    }

    const trimmed = inputText.trim();

    // Req 1.6: below the threshold we never call the API and we clear any
    // previously displayed results.
    if (trimmed.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      abortRef.current = null;
      setResults([]);
      setStatus('idle');
      setActiveIndex(-1);
      setIsOpen(false);
      return;
    }

    setStatus('loading');
    setIsOpen(true);

    const handle = setTimeout(() => {
      // Cancel any earlier request still in flight before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          const locations = await client.searchLocations(
            trimmed,
            controller.signal,
          );
          if (controller.signal.aborted) {
            return;
          }
          const capped = locations.slice(0, MAX_RESULTS);
          setResults(capped);
          setStatus(capped.length === 0 ? 'empty' : 'results');
          setActiveIndex(-1);
          setIsOpen(true);
        } catch (error) {
          // A cancelled stale request is expected; ignore it.
          if (controller.signal.aborted || isAbortError(error)) {
            return;
          }
          // Req 1.5: surface a service-unavailable message but RETAIN the typed
          // text (we deliberately do not touch `inputText` here).
          setResults([]);
          setStatus('error');
          setActiveIndex(-1);
          setIsOpen(true);
        }
      })();
    }, debounceMs);

    return () => {
      clearTimeout(handle);
    };
  }, [inputText, debounceMs, client]);

  const handleChange = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>): void => {
      const next = event.target.value;
      setInputText(next);
      // Editing the text invalidates any prior selection (Req 1.3 semantics:
      // the field's value should reflect what the user actually chose).
      if (value) {
        onSelect(null, fieldId);
      }
    },
    [value, onSelect, fieldId],
  );

  const handleSelect = useCallback(
    (location: Location): void => {
      // Req 1.3: store the selection as the field's value and surface it.
      skipNextQueryRef.current = true;
      setInputText(location.name);
      setResults([]);
      setStatus('idle');
      setActiveIndex(-1);
      setIsOpen(false);
      onSelect(location, fieldId);
    },
    [onSelect, fieldId],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setActiveIndex(-1);
        return;
      }

      if (status !== 'results' || results.length === 0) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setIsOpen(true);
          setActiveIndex((prev) => (prev + 1) % results.length);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setIsOpen(true);
          setActiveIndex((prev) =>
            prev <= 0 ? results.length - 1 : prev - 1,
          );
          break;
        case 'Enter':
          if (activeIndex >= 0 && activeIndex < results.length) {
            const active = results[activeIndex];
            if (active) {
              event.preventDefault();
              handleSelect(active);
            }
          }
          break;
        default:
          break;
      }
    },
    [status, results, activeIndex, handleSelect],
  );

  const showListbox = isOpen && status === 'results' && results.length > 0;
  const activeDescendant =
    showListbox && activeIndex >= 0 ? optionId(activeIndex) : undefined;

  return (
    <div className="location-search">
      <label className="location-search__label" htmlFor={inputId}>
        {label}
      </label>

      <input
        id={inputId}
        className="location-search__input"
        type="text"
        autoComplete="off"
        value={inputText}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={showListbox}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendant}
        aria-describedby={statusId}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      {/* Polite live region for transient status + empty/error messages. */}
      <div
        id={statusId}
        className="location-search__status"
        role="status"
        aria-live="polite"
      >
        {status === 'loading' && (
          <span className="location-search__hint">{MESSAGES.loading}</span>
        )}
        {status === 'empty' && (
          <span className="location-search__message location-search__message--empty">
            {MESSAGES.noResults}
          </span>
        )}
        {status === 'error' && (
          <span
            className="location-search__message location-search__message--error"
            role="alert"
          >
            {MESSAGES.serviceUnavailable}
          </span>
        )}
      </div>

      {showListbox && (
        <ul
          id={listboxId}
          className="location-search__results"
          role="listbox"
          aria-label={`${label} results`}
        >
          {results.map((location, index) => {
            const isActive = index === activeIndex;
            const isSelected = value?.id === location.id;
            return (
              <li
                key={location.id}
                id={optionId(index)}
                className={
                  'location-search__option' +
                  (isActive ? ' location-search__option--active' : '')
                }
                role="option"
                aria-selected={isSelected}
                // Use onMouseDown so the selection fires before the input blurs.
                onMouseDown={(event) => {
                  event.preventDefault();
                  handleSelect(location);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="location-search__option-name">
                  {location.name}
                </span>
                <span className="location-search__option-meta">
                  <span className="location-search__option-type">
                    {LOCATION_TYPE_LABEL[location.type]}
                  </span>
                  {location.suburb && (
                    <span className="location-search__option-suburb">
                      {location.suburb}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
