// @vitest-environment jsdom
//
// Unit / responsive tests for RouteComparisonView (Task 11.9).
//
// These are example-based tests (per the design's Testing Strategy and
// "Frontend / Responsive Tests") covering the comparison-view behaviours that
// are NOT universal properties:
//   - Req 5.1 / 5.2 / 5.3: two distinct routes render side by side with travel
//     time, total estimated fare (AUD, two decimals, labelled an estimate),
//     transfers and modes, plus the travel-time and fare differences with
//     faster/cheaper labels.
//   - Req 5.4: when the fastest and economical routes coincide (`sameRoute`),
//     the view collapses to a single route flagged as both fastest and most
//     economical.
//   - Req 5.6: when the fastest route has no fare (`fareUnavailableForFastest`),
//     the view shows the notice and does not surface a fare difference.
//   - Req 5.5: selecting a route calls `onSelect` with the resolved `Journey`
//     (matched by id against the `journeys` prop).
//
// The comparison view renders fare values across several text nodes
// ("$5.40 (estimate)"), so formatted-value assertions check the rendered
// container text, while structural assertions use accessible roles/labels.
// All user-facing copy is asserted via the exported COMPARISON_MESSAGES so the
// test and the UI share a single source of truth.

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatAud, formatDuration } from '@tfnsw/shared';
import type {
  ComparisonEntry,
  Journey,
  RouteComparison,
  TransportMode,
} from '../api/types';
import { formatMode, formatTransfers } from './routeFormat';
import {
  COMPARISON_MESSAGES,
  RouteComparisonView,
} from './RouteComparisonView';

// --- Fixtures --------------------------------------------------------------

/**
 * Builds a type-complete `Journey`. The comparison view does not render the
 * legs, so an empty leg list keeps fixtures focused on the fields that matter
 * (id for selection, plus the comparison metrics mirrored in ComparisonEntry).
 */
function makeJourney(overrides: Partial<Journey> & { id: string }): Journey {
  return {
    legs: [],
    departureTime: '2025-01-01T08:00:00Z',
    arrivalTime: '2025-01-01T08:30:00Z',
    travelTimeMinutes: 30,
    transferCount: 0,
    modes: ['train'],
    totalFare: { amountCents: 0, currency: 'AUD' },
    ...overrides,
  };
}

/** Builds a `ComparisonEntry` from a journey-like shape. */
function entryFor(j: {
  id: string;
  travelTimeMinutes: number;
  totalFare: ComparisonEntry['totalFare'];
  transferCount: number;
  modes: TransportMode[];
}): ComparisonEntry {
  return {
    journeyId: j.id,
    travelTimeMinutes: j.travelTimeMinutes,
    totalFare: j.totalFare,
    transferCount: j.transferCount,
    modes: j.modes,
  };
}

// Two distinct routes: the fastest is quicker (30m, 1 transfer, $5.40) and the
// economical is cheaper (45m, direct, $3.80).
const FAST_JOURNEY = makeJourney({
  id: 'j-fast',
  travelTimeMinutes: 30,
  transferCount: 1,
  modes: ['train', 'bus'],
  totalFare: { amountCents: 540, currency: 'AUD' },
});

const ECO_JOURNEY = makeJourney({
  id: 'j-eco',
  travelTimeMinutes: 45,
  transferCount: 0,
  modes: ['bus'],
  totalFare: { amountCents: 380, currency: 'AUD' },
});

const TWO_ROUTE_JOURNEYS: Journey[] = [FAST_JOURNEY, ECO_JOURNEY];

function twoRouteComparison(): RouteComparison {
  return {
    fastest: entryFor(FAST_JOURNEY),
    economical: entryFor(ECO_JOURNEY),
    sameRoute: false,
    travelTimeDifferenceMinutes: 15, // |30 - 45|
    fareDifferenceCents: 160, // |540 - 380|
    fasterRouteId: FAST_JOURNEY.id,
    cheaperRouteId: ECO_JOURNEY.id,
    fareUnavailableForFastest: false,
  };
}

// --- Setup -----------------------------------------------------------------

afterEach(() => {
  cleanup();
});

// --- Tests -----------------------------------------------------------------

describe('RouteComparisonView', () => {
  it('renders two distinct routes side by side with metrics, estimated fares, and faster/cheaper differences (Req 5.1, 5.2, 5.3)', () => {
    const { container } = render(
      <RouteComparisonView
        comparison={twoRouteComparison()}
        journeys={TWO_ROUTE_JOURNEYS}
      />,
    );
    const text = container.textContent ?? '';

    // Both route roles are presented side by side (two route cards).
    expect(text).toContain(COMPARISON_MESSAGES.fastestLabel);
    expect(text).toContain(COMPARISON_MESSAGES.economicalLabel);
    expect(container.querySelectorAll('.comparison-card-item')).toHaveLength(2);

    // Travel time (h/m) for each route (Req 5.2).
    expect(text).toContain(formatDuration(FAST_JOURNEY.travelTimeMinutes)); // 30m
    expect(text).toContain(formatDuration(ECO_JOURNEY.travelTimeMinutes)); // 45m

    // Total fare in AUD to two decimals, labelled as an estimate (Req 5.2).
    expect(text).toContain(`$${formatAud(540)}`); // $5.40
    expect(text).toContain(`$${formatAud(380)}`); // $3.80
    expect(text).toContain(`(${COMPARISON_MESSAGES.fareEstimate})`);

    // Transfers for each route (Req 5.2).
    expect(text).toContain(formatTransfers(1)); // 1 transfer
    expect(text).toContain(formatTransfers(0)); // Direct

    // Modes for each route (Req 5.2).
    expect(text).toContain(formatMode('train'));
    expect(text).toContain(formatMode('bus'));

    // Travel-time difference with the "faster" label (Req 5.3).
    expect(text).toContain(COMPARISON_MESSAGES.travelTimeDiffLabel);
    expect(text).toContain(formatDuration(15)); // 15m
    expect(text).toContain(`${COMPARISON_MESSAGES.fastestLabel} is faster`);

    // Fare difference with the "cheaper" label (Req 5.3).
    expect(text).toContain(COMPARISON_MESSAGES.fareDiffLabel);
    expect(text).toContain(`$${formatAud(160)}`); // $1.60
    expect(text).toContain(`${COMPARISON_MESSAGES.economicalLabel} is cheaper`);
  });

  it('collapses to a single route flagged as both fastest and most economical when sameRoute is true (Req 5.4)', () => {
    const sharedEntry = entryFor(FAST_JOURNEY);
    const comparison: RouteComparison = {
      fastest: sharedEntry,
      economical: sharedEntry,
      sameRoute: true,
      travelTimeDifferenceMinutes: 0,
      fareDifferenceCents: 0,
      fasterRouteId: FAST_JOURNEY.id,
      cheaperRouteId: FAST_JOURNEY.id,
      fareUnavailableForFastest: false,
    };

    const { container } = render(
      <RouteComparisonView comparison={comparison} journeys={[FAST_JOURNEY]} />,
    );
    const text = container.textContent ?? '';

    // A single route card labelled as both fastest and most economical.
    expect(container.querySelectorAll('.comparison-card-item')).toHaveLength(1);
    expect(text).toContain(COMPARISON_MESSAGES.bothLabel);

    // The single-route layout is used and no separate difference summary is
    // rendered (nothing to compare against).
    expect(
      container.querySelector('.comparison__routes--single'),
    ).not.toBeNull();
    expect(container.querySelector('.comparison-diff')).toBeNull();

    // Still surfaces the route's metrics and estimated fare.
    expect(text).toContain(formatDuration(FAST_JOURNEY.travelTimeMinutes));
    expect(text).toContain(`$${formatAud(540)}`);
    expect(text).toContain(`(${COMPARISON_MESSAGES.fareEstimate})`);
  });

  it('shows the fare-unavailable notice and no fare difference when the fastest route has no fare (Req 5.6)', () => {
    const fastNoFare = makeJourney({
      id: 'j-fast-nofare',
      travelTimeMinutes: 30,
      transferCount: 1,
      modes: ['train'],
      totalFare: null,
    });
    const comparison: RouteComparison = {
      fastest: entryFor(fastNoFare),
      economical: entryFor(ECO_JOURNEY),
      sameRoute: false,
      travelTimeDifferenceMinutes: 15,
      fareDifferenceCents: null, // not computable without the fastest fare
      fasterRouteId: fastNoFare.id,
      cheaperRouteId: null,
      fareUnavailableForFastest: true,
    };

    const { container } = render(
      <RouteComparisonView
        comparison={comparison}
        journeys={[fastNoFare, ECO_JOURNEY]}
      />,
    );
    const text = container.textContent ?? '';

    // The notice is shown (Req 5.6).
    expect(text).toContain(COMPARISON_MESSAGES.fareUnavailableNotice);
    expect(container.querySelector('.comparison__notice')).not.toBeNull();

    // The fastest route surfaces the "fare estimate not available" state rather
    // than a dollar amount.
    expect(text).toContain(COMPARISON_MESSAGES.fareUnavailable);

    // No fare difference is presented: the fare-difference value reads as
    // unavailable and no "is cheaper" label is rendered.
    expect(text).toContain(COMPARISON_MESSAGES.fareDiffLabel);
    expect(text).toContain(COMPARISON_MESSAGES.unavailable);
    expect(text).not.toContain('is cheaper');

    // Travel time is still compared (Req 5.6).
    expect(text).toContain(COMPARISON_MESSAGES.travelTimeDiffLabel);
    expect(text).toContain(formatDuration(15));
  });

  it('calls onSelect with the resolved Journey (matched by id) when a route is selected (Req 5.5)', () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <RouteComparisonView
        comparison={twoRouteComparison()}
        journeys={TWO_ROUTE_JOURNEYS}
        onSelect={onSelect}
      />,
    );

    // Each route renders as a focusable button labelled by its role.
    const fastestButton = getByRole('button', {
      name: new RegExp(COMPARISON_MESSAGES.fastestLabel),
    });
    fireEvent.click(fastestButton);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(FAST_JOURNEY);

    const economicalButton = getByRole('button', {
      name: new RegExp(COMPARISON_MESSAGES.economicalLabel),
    });
    fireEvent.click(economicalButton);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(ECO_JOURNEY);
  });
});
