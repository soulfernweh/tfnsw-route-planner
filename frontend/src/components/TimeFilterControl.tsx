// TimeFilterControl — the Time_Filter for a route search (Requirement 7).
//
// Offers three mutually-exclusive options as an accessible radio group:
//   - "Leave now"  (default, Req 7.1/7.2)
//   - "Leave at"   (depart at a chosen time)
//   - "Arrive by"  (arrive at/before a chosen time)
//
// For "Leave at" / "Arrive by" a labelled `datetime-local` input is shown so
// the user can pick the Selected_Time. The control surfaces its state to the
// parent via `onChange({ when, time })`:
//   - `when`  — the chosen filter.
//   - `time`  — an ISO 8601 string for leaveAt/arriveBy; undefined for leaveNow
//               (the backend uses the current time) or while no time is picked.
//
// Mobile-first: the options stack and the datetime input fills the width.

import { useCallback, useId, useState } from 'react';
import type { WhenFilter } from '../api/client';
import './TimeFilterControl.css';

/** The value surfaced to the parent on every change. */
export interface TimeFilterValue {
  /** The chosen Time_Filter. */
  when: WhenFilter;
  /**
   * ISO 8601 Selected_Time. Present for leaveAt/arriveBy when a time has been
   * picked; undefined for leaveNow or when no time is selected yet.
   */
  time?: string;
}

export interface TimeFilterControlProps {
  /** Notifies the parent whenever the filter or time changes. */
  onChange: (value: TimeFilterValue) => void;
}

/** The selectable options, in display order. "Leave now" is the default. */
const OPTIONS: ReadonlyArray<{ when: WhenFilter; label: string }> = [
  { when: 'leaveNow', label: 'Leave now' },
  { when: 'leaveAt', label: 'Leave at' },
  { when: 'arriveBy', label: 'Arrive by' },
];

/**
 * Converts a `datetime-local` value (e.g. "2024-01-15T08:05", interpreted in
 * the user's local time zone) to an ISO 8601 UTC string. Returns undefined for
 * an empty or unparseable value.
 */
function localInputToIso(local: string): string | undefined {
  if (local.trim() === '') {
    return undefined;
  }
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

/** Accessible Time_Filter control. See module header. */
export function TimeFilterControl({
  onChange,
}: TimeFilterControlProps): JSX.Element {
  const [when, setWhen] = useState<WhenFilter>('leaveNow');
  // The raw `datetime-local` input value (local wall-clock), kept so toggling
  // between Leave at / Arrive by preserves the user's chosen time.
  const [localTime, setLocalTime] = useState<string>('');

  const baseId = useId();
  const groupLabelId = `${baseId}-label`;
  const timeInputId = `${baseId}-time`;

  const emit = useCallback(
    (nextWhen: WhenFilter, nextLocalTime: string): void => {
      if (nextWhen === 'leaveNow') {
        onChange({ when: nextWhen });
        return;
      }
      const iso = localInputToIso(nextLocalTime);
      onChange(iso !== undefined ? { when: nextWhen, time: iso } : { when: nextWhen });
    },
    [onChange],
  );

  const handleWhenChange = useCallback(
    (nextWhen: WhenFilter): void => {
      setWhen(nextWhen);
      emit(nextWhen, localTime);
    },
    [emit, localTime],
  );

  const handleTimeChange = useCallback(
    (nextLocalTime: string): void => {
      setLocalTime(nextLocalTime);
      emit(when, nextLocalTime);
    },
    [emit, when],
  );

  const showTimeInput = when === 'leaveAt' || when === 'arriveBy';

  return (
    <div className="time-filter">
      <fieldset className="time-filter__fieldset">
        <legend className="time-filter__legend" id={groupLabelId}>
          When
        </legend>

        <div className="time-filter__options" role="radiogroup" aria-labelledby={groupLabelId}>
          {OPTIONS.map((option) => (
            <label key={option.when} className="time-filter__option">
              <input
                type="radio"
                name={`${baseId}-when`}
                className="time-filter__radio"
                value={option.when}
                checked={when === option.when}
                onChange={() => handleWhenChange(option.when)}
              />
              <span className="time-filter__option-label">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {showTimeInput && (
        <div className="time-filter__time">
          <label className="time-filter__time-label" htmlFor={timeInputId}>
            {when === 'arriveBy' ? 'Arrive by' : 'Leave at'}
          </label>
          <input
            id={timeInputId}
            className="time-filter__time-input"
            type="datetime-local"
            value={localTime}
            onChange={(event) => handleTimeChange(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
