// @vitest-environment jsdom
//
// Unit tests for TimeFilterControl (task 19.2).
//
// Covers the Time_Filter control behaviours (Requirement 7):
//   - Defaults to "Leave now" with NO datetime input shown (Req 7.1, 7.2).
//   - Selecting "Leave at" / "Arrive by" reveals the datetime input and
//     surfaces the corresponding `when` to the parent via onChange.
//   - Choosing a datetime surfaces an ISO 8601 `time` alongside the `when`.
//
// A per-file `@vitest-environment jsdom` docblock (above) keeps this file
// self-contained, mirroring the other component tests.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import { TimeFilterControl } from './TimeFilterControl';

afterEach(() => {
  cleanup();
});

/** Returns the radio for a given Time_Filter label. */
function radio(name: string): HTMLInputElement {
  return screen.getByRole('radio', { name }) as HTMLInputElement;
}

/** The (optional) datetime-local input; null when not rendered. */
function datetimeInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[type="datetime-local"]');
}

describe('TimeFilterControl defaults (Req 7.1, 7.2)', () => {
  it('defaults to "Leave now" with no datetime input shown', () => {
    const onChange = vi.fn();
    const { container } = render(<TimeFilterControl onChange={onChange} />);

    // "Leave now" is selected; the other options are not.
    expect(radio('Leave now')).toBeChecked();
    expect(radio('Leave at')).not.toBeChecked();
    expect(radio('Arrive by')).not.toBeChecked();

    // No datetime input is shown for "Leave now".
    expect(datetimeInput(container)).toBeNull();

    // The control does not emit anything until the user changes it.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('TimeFilterControl reveals the datetime input (Req 7.3, 7.4)', () => {
  it('shows the datetime input and reports `when: "leaveAt"` when "Leave at" is chosen', () => {
    const onChange = vi.fn();
    const { container } = render(<TimeFilterControl onChange={onChange} />);

    fireEvent.click(radio('Leave at'));

    expect(radio('Leave at')).toBeChecked();
    // The datetime input is now revealed.
    expect(datetimeInput(container)).not.toBeNull();
    // With no time picked yet, only the `when` is reported.
    expect(onChange).toHaveBeenLastCalledWith({ when: 'leaveAt' });
  });

  it('shows the datetime input and reports `when: "arriveBy"` when "Arrive by" is chosen', () => {
    const onChange = vi.fn();
    const { container } = render(<TimeFilterControl onChange={onChange} />);

    fireEvent.click(radio('Arrive by'));

    expect(radio('Arrive by')).toBeChecked();
    expect(datetimeInput(container)).not.toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ when: 'arriveBy' });
  });

  it('hides the datetime input again when switching back to "Leave now"', () => {
    const onChange = vi.fn();
    const { container } = render(<TimeFilterControl onChange={onChange} />);

    fireEvent.click(radio('Leave at'));
    expect(datetimeInput(container)).not.toBeNull();

    fireEvent.click(radio('Leave now'));
    expect(datetimeInput(container)).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ when: 'leaveNow' });
  });
});

describe('TimeFilterControl surfaces an ISO time (Req 7.3, 7.4)', () => {
  it('reports an ISO 8601 `time` once a datetime is chosen for "Leave at"', () => {
    const onChange = vi.fn();
    const { container } = render(<TimeFilterControl onChange={onChange} />);

    fireEvent.click(radio('Leave at'));
    const input = datetimeInput(container);
    expect(input).not.toBeNull();

    const localValue = '2024-01-15T08:05';
    fireEvent.change(input as HTMLInputElement, {
      target: { value: localValue },
    });

    const lastArg = onChange.mock.calls.at(-1)?.[0];
    expect(lastArg.when).toBe('leaveAt');
    // The reported time is the ISO 8601 form of the picked local time.
    expect(lastArg.time).toBe(new Date(localValue).toISOString());
    expect(lastArg.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('reports an ISO 8601 `time` once a datetime is chosen for "Arrive by"', () => {
    const onChange = vi.fn();
    const { container } = render(<TimeFilterControl onChange={onChange} />);

    fireEvent.click(radio('Arrive by'));
    const input = datetimeInput(container);
    expect(input).not.toBeNull();

    const localValue = '2024-06-30T17:45';
    fireEvent.change(input as HTMLInputElement, {
      target: { value: localValue },
    });

    const lastArg = onChange.mock.calls.at(-1)?.[0];
    expect(lastArg.when).toBe('arriveBy');
    expect(lastArg.time).toBe(new Date(localValue).toISOString());
  });
});
