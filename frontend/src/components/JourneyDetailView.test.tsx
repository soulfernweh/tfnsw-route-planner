// @vitest-environment jsdom
//
// Unit tests for the prop-driven JourneyDetailView (Task 11.7).
//
// JourneyDetailView is purely presentational (after task 11.10): it renders the
// already-fetched journey passed in as a prop and never fetches anything. These
// example-based tests cover the rendering and retry behaviours that are NOT
// universal properties:
//   - Req 3.2: leg-by-leg detail renders the per-leg times, transport mode, and
//     platform information where the data provides it.
//   - Req 4.2 / 5.5: when this is the economical selection, per-leg fares and
//     the total fare render and are clearly labelled as estimates.
//   - Req 3.4: when `error` is set, the "could not be loaded" message renders
//     with a Retry button that invokes `onRetry` when clicked.
//   - The empty prompt renders when there is neither a journey nor an error.
//
// We assert on user-visible text and on the `<time>` elements' `dateTime`
// attributes for leg times, which keeps the per-leg time assertions independent
// of the test machine's locale/timezone.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Fare, Journey, Leg, LegStop } from '../api/types';
import { DETAIL_MESSAGES, JourneyDetailView } from './JourneyDetailView';

// --- Fixture builders ------------------------------------------------------

function fare(amountCents: number): Fare {
  return { amountCents, currency: 'AUD' };
}

function stop(
  locationName: string,
  time: string,
  platform: string | null = null,
): LegStop {
  return { locationName, time, platform };
}

/** Builds a single leg with sensible defaults; override per test. */
function makeLeg(overrides: Partial<Leg> = {}): Leg {
  const base: Leg = {
    origin: stop('Town Hall Station', '2025-01-06T08:00:00+11:00', '3'),
    destination: stop('Central Station', '2025-01-06T08:05:00+11:00', '18'),
    mode: 'train',
    routeName: 'T1 North Shore Line',
    departureTime: '2025-01-06T08:00:00+11:00',
    arrivalTime: '2025-01-06T08:05:00+11:00',
    durationMinutes: 5,
    isTransfer: false,
    fare: fare(360),
  };
  return { ...base, ...overrides };
}

/** Builds a journey with sensible defaults; override per test. */
function makeJourney(overrides: Partial<Journey> = {}): Journey {
  const legs = overrides.legs ?? [
    makeLeg(),
    makeLeg({
      origin: stop('Central Station', '2025-01-06T08:10:00+11:00', '21'),
      destination: stop('Redfern Station', '2025-01-06T08:14:00+11:00', '9'),
      mode: 'bus',
      routeName: '389',
      departureTime: '2025-01-06T08:10:00+11:00',
      arrivalTime: '2025-01-06T08:14:00+11:00',
      durationMinutes: 4,
      fare: fare(290),
    }),
  ];
  const base: Journey = {
    id: 'journey-1',
    legs,
    departureTime: '2025-01-06T08:00:00+11:00',
    arrivalTime: '2025-01-06T08:14:00+11:00',
    travelTimeMinutes: 14,
    transferCount: 1,
    modes: ['train', 'bus'],
    totalFare: fare(650),
  };
  return { ...base, ...overrides };
}

/** Collects the `dateTime` attribute of every rendered <time> element. */
function renderedLegTimes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('time')).map(
    (el) => el.getAttribute('dateTime') ?? '',
  );
}

// --- Setup -----------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- Tests -----------------------------------------------------------------

describe('JourneyDetailView', () => {
  it('renders per-leg platform, times, and modes (Req 3.2)', () => {
    const journey = makeJourney();
    const { container } = render(<JourneyDetailView journey={journey} />);

    // Platform text from the stops renders where the data provides it.
    expect(screen.getByText('Platform 3')).toBeTruthy();
    expect(screen.getByText('Platform 18')).toBeTruthy();
    expect(screen.getByText('Platform 21')).toBeTruthy();
    expect(screen.getByText('Platform 9')).toBeTruthy();

    // Location names for both legs render.
    expect(screen.getAllByText('Town Hall Station').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Central Station').length).toBeGreaterThan(0);
    expect(screen.getByText('Redfern Station')).toBeTruthy();

    // Per-leg modes (and route names) render via the mode badge.
    expect(screen.getByText('Train · T1 North Shore Line')).toBeTruthy();
    expect(screen.getByText('Bus · 389')).toBeTruthy();

    // Per-leg times render as <time> elements carrying the ISO timestamps.
    // (Asserting on dateTime keeps this independent of the host timezone.)
    const times = renderedLegTimes(container);
    expect(times).toContain('2025-01-06T08:00:00+11:00');
    expect(times).toContain('2025-01-06T08:05:00+11:00');
    expect(times).toContain('2025-01-06T08:10:00+11:00');
    expect(times).toContain('2025-01-06T08:14:00+11:00');
  });

  it('omits platform text when a stop has no platform (Req 3.2)', () => {
    const journey = makeJourney({
      legs: [
        makeLeg({
          origin: stop('Wynyard Station', '2025-01-06T09:00:00+11:00', null),
          destination: stop(
            'Town Hall Station',
            '2025-01-06T09:03:00+11:00',
            null,
          ),
        }),
      ],
    });
    render(<JourneyDetailView journey={journey} />);

    expect(screen.queryByText(/Platform/)).toBeNull();
  });

  it('renders per-leg and total fares labelled as estimates when economical (Req 4.2, 5.5)', () => {
    const journey = makeJourney();
    render(<JourneyDetailView journey={journey} isEconomical />);

    // Per-leg fares render (formatAud: 360 -> "3.60", 290 -> "2.90").
    expect(screen.getByText(/3\.60/)).toBeTruthy();
    expect(screen.getByText(/2\.90/)).toBeTruthy();

    // The total fare (650 -> "6.50") renders.
    expect(screen.getByText(/6\.50/)).toBeTruthy();

    // Fares are explicitly labelled as estimates: the per-leg "(est.)" markers
    // appear, plus the total-fare "(estimate)" tag and the explanatory note.
    expect(screen.getAllByText(/\(est\.\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\(estimate\)/)).toBeTruthy();
    expect(screen.getByText(DETAIL_MESSAGES.fareEstimateDetail)).toBeTruthy();
  });

  it('does not render fares or the estimate note when not economical (Req 4.2)', () => {
    const journey = makeJourney();
    render(<JourneyDetailView journey={journey} isEconomical={false} />);

    expect(screen.queryByText(/\(est\.\)/)).toBeNull();
    expect(screen.queryByText(DETAIL_MESSAGES.fareEstimateDetail)).toBeNull();
  });

  it('shows the "could not be loaded" message and a working Retry button on error (Req 3.4)', () => {
    const onRetry = vi.fn();
    render(<JourneyDetailView error onRetry={onRetry} />);

    // The error message renders instead of journey detail.
    expect(screen.getByText(DETAIL_MESSAGES.error)).toBeTruthy();

    // A Retry button is shown and clicking it invokes onRetry (Req 3.4).
    const retry = screen.getByRole('button', { name: DETAIL_MESSAGES.retry });
    expect(retry).toBeTruthy();

    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the empty prompt when there is no journey and no error', () => {
    render(<JourneyDetailView />);

    expect(screen.getByText(DETAIL_MESSAGES.empty)).toBeTruthy();
    // No error message and no retry control in the empty state.
    expect(screen.queryByText(DETAIL_MESSAGES.error)).toBeNull();
    expect(screen.queryByRole('button', { name: DETAIL_MESSAGES.retry })).toBeNull();
  });
});
