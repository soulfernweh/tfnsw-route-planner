// @vitest-environment jsdom
//
// Unit tests for ModeSelectionControl (task 19.2).
//
// Covers the Mode_Selection control behaviours (Requirement 6):
//   - All seven user-selectable modes are checked by default (Req 6.1, 6.2),
//     and toggling reports the selected set to the parent via onChange.
//   - Unchecking one mode drops it from the reported set.
//   - Unchecking ALL modes surfaces the empty set and shows the
//     NO_MODES_MESSAGE validation hint (Req 6.4).
//
// A per-file `@vitest-environment jsdom` docblock (above) keeps this file
// self-contained, mirroring the other component tests.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import { ModeSelectionControl, NO_MODES_MESSAGE } from './ModeSelectionControl';

afterEach(() => {
  cleanup();
});

/** The seven mode labels, in canonical control order. */
const MODE_LABELS = [
  'Train',
  'Metro',
  'Light Rail',
  'Bus',
  'Coach',
  'Ferry',
  'School Bus',
] as const;

/** The canonical SelectableMode order the control emits in. */
const ALL_MODES = [
  'train',
  'metro',
  'lightRail',
  'bus',
  'coach',
  'ferry',
  'school',
] as const;

/** Returns the checkbox for a given mode label. */
function checkbox(name: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement;
}

describe('ModeSelectionControl defaults (Req 6.1, 6.2)', () => {
  it('renders all seven modes checked by default', () => {
    render(<ModeSelectionControl onChange={vi.fn()} />);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(7);
    for (const label of MODE_LABELS) {
      expect(checkbox(label)).toBeChecked();
    }
  });

  it('reports the full set of seven modes when a deselected mode is re-checked', () => {
    const onChange = vi.fn();
    render(<ModeSelectionControl onChange={onChange} />);

    // Uncheck then re-check Train: the control reports all seven again, in
    // canonical control order.
    fireEvent.click(checkbox('Train'));
    fireEvent.click(checkbox('Train'));

    expect(onChange).toHaveBeenLastCalledWith([...ALL_MODES]);
  });
});

describe('ModeSelectionControl unchecking a mode (Req 6.3)', () => {
  it('drops the unchecked mode from the reported set', () => {
    const onChange = vi.fn();
    render(<ModeSelectionControl onChange={onChange} />);

    fireEvent.click(checkbox('Train'));

    // The reported set is the remaining six, in canonical control order.
    expect(onChange).toHaveBeenLastCalledWith([
      'metro',
      'lightRail',
      'bus',
      'coach',
      'ferry',
      'school',
    ]);
    expect(checkbox('Train')).not.toBeChecked();
  });
});

describe('ModeSelectionControl unchecking all modes (Req 6.4)', () => {
  it('surfaces the empty set and shows the no-modes validation message', () => {
    const onChange = vi.fn();
    render(<ModeSelectionControl onChange={onChange} />);

    // Uncheck every mode.
    for (const label of MODE_LABELS) {
      fireEvent.click(checkbox(label));
    }

    // The final reported set is empty.
    expect(onChange).toHaveBeenLastCalledWith([]);

    // The validation hint is shown so the consumer can block the search.
    expect(screen.getByText(NO_MODES_MESSAGE)).toBeInTheDocument();
  });
});
