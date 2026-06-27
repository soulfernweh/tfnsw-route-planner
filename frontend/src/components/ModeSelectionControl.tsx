// ModeSelectionControl — the Mode_Selection control (Requirement 6).
//
// Renders seven checkboxes for the user-selectable transport modes (Train,
// Metro, Light Rail, Bus, Coach, Ferry, School Bus), ALL checked by default
// (Req 6.1, 6.2). It surfaces the currently-selected `SelectableMode[]` to the
// parent via `onChange`. When the user unchecks every mode the parent receives
// an empty array so it can block the search and show the "at least one
// transport mode is required" validation message (Req 6.4); for completeness
// the control also renders an inline hint in that state.
//
// Mobile-first: the checkboxes wrap into a comfortable tappable grid.

import { useCallback, useId, useState } from 'react';
import type { SelectableMode } from '../api/types';
import { ALL_SELECTABLE_MODES } from '../api/client';
import './ModeSelectionControl.css';

/** Validation message shown when no transport mode is selected (Req 6.4). */
export const NO_MODES_MESSAGE = 'At least one transport mode is required.';

/** Display labels for each selectable mode, in control order. */
const MODE_LABELS: Record<SelectableMode, string> = {
  train: 'Train',
  metro: 'Metro',
  lightRail: 'Light Rail',
  bus: 'Bus',
  coach: 'Coach',
  ferry: 'Ferry',
  school: 'School Bus',
};

export interface ModeSelectionControlProps {
  /** Notifies the parent with the selected modes whenever the selection changes. */
  onChange: (modes: SelectableMode[]) => void;
}

/** Accessible Mode_Selection control. See module header. */
export function ModeSelectionControl({
  onChange,
}: ModeSelectionControlProps): JSX.Element {
  // All modes selected by default (Req 6.1, 6.2). Stored as a Set for cheap
  // toggling; emitted to the parent in canonical control order.
  const [selected, setSelected] = useState<Set<SelectableMode>>(
    () => new Set(ALL_SELECTABLE_MODES),
  );

  const baseId = useId();
  const groupLabelId = `${baseId}-label`;
  const hintId = `${baseId}-hint`;

  const toggle = useCallback(
    (mode: SelectableMode): void => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(mode)) {
          next.delete(mode);
        } else {
          next.add(mode);
        }
        // Emit in canonical control order so the parent gets a stable list.
        onChange(ALL_SELECTABLE_MODES.filter((m) => next.has(m)));
        return next;
      });
    },
    [onChange],
  );

  const noneSelected = selected.size === 0;

  return (
    <div className="mode-selection">
      <fieldset className="mode-selection__fieldset">
        <legend className="mode-selection__legend" id={groupLabelId}>
          Transport modes
        </legend>

        <div
          className="mode-selection__options"
          aria-labelledby={groupLabelId}
          {...(noneSelected ? { 'aria-describedby': hintId } : {})}
        >
          {ALL_SELECTABLE_MODES.map((mode) => (
            <label key={mode} className="mode-selection__option">
              <input
                type="checkbox"
                className="mode-selection__checkbox"
                checked={selected.has(mode)}
                onChange={() => toggle(mode)}
              />
              <span className="mode-selection__option-label">
                {MODE_LABELS[mode]}
              </span>
            </label>
          ))}
        </div>

        {noneSelected && (
          <p
            id={hintId}
            className="mode-selection__hint"
            role="alert"
          >
            {NO_MODES_MESSAGE}
          </p>
        )}
      </fieldset>
    </div>
  );
}
