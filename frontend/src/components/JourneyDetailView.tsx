// JourneyDetailView — full leg-by-leg detail for a selected journey.
//
// Used when a route is chosen from the route list or the comparison view
// (Req 5.5). The TfNSW API has no journey-detail endpoint and no journey id:
// the `/api/routes` response already carries complete leg-by-leg detail for
// every journey. This component is therefore PURELY PRESENTATIONAL — it renders
// from the already-fetched `Journey` passed in as a prop rather than fetching
// anything itself. For every leg it shows:
//   - the origin and destination location names (Req 3.2),
//   - the per-leg scheduled departure and arrival times (Req 3.2),
//   - the transport mode and route name (Req 3.2),
//   - platform information where the upstream data provides it (Req 3.2),
//   - the per-leg fare, when this is the economical selection (Req 4.2).
//
// For the economical selection it also surfaces the total Fare_Cost (Req 4.2),
// formatted with the shared `formatAud` helper so currency renders as AUD with
// exactly two decimals, consistent with the comparison view. Travel time uses
// the shared `formatDuration` helper.
//
// Fares are ESTIMATES: the TfNSW trip endpoint returns no fare data, so all
// fares are computed by the backend's Opal Fare Calculator. The view labels
// them as estimates near the fare display.
//
// Error handling (Req 3.4): because journey detail is part of the route-search
// response (not a separate fetch), there is no internal error state. Instead an
// optional `error` flag plus `onRetry` callback drive an error/retry rendering
// path; the parent (route search) wires `onRetry` to re-run the route search.
//
// Mobile-first & accessible: the legs render as a vertical, full-width list on
// phones; the timeline gains a little horizontal layout from the tablet
// breakpoint up. The error state uses an assertive live region and the retry
// control is a real, focusable button.

import { formatAud, formatDuration } from '@tfnsw/shared';
import type { Journey, Leg } from '../api/types';
import { formatClockTime, formatMode, formatTransfers } from './routeFormat';
import './JourneyDetailView.css';

/** User-facing messages (kept here so tests and UI share one source). */
export const DETAIL_MESSAGES = {
  error: 'Journey details could not be loaded. Please try again.',
  retry: 'Retry',
  noFare: 'Fare data not available',
  empty: 'Select a route to see its full details.',
  fareEstimate: 'Fares are estimates',
  fareEstimateDetail:
    'Fares are estimates only and may differ from the actual Opal fare.',
} as const;

export interface JourneyDetailViewProps {
  /**
   * The already-fetched journey to render, taken from the route-search result.
   * When omitted (e.g. nothing selected yet), an empty prompt is shown unless
   * `error` is set.
   */
  journey?: Journey | null;
  /**
   * Whether this journey is the economical selection. When true, per-leg fares
   * and the total Fare_Cost are shown and labelled as estimates (Req 4.2).
   */
  isEconomical?: boolean;
  /**
   * Optional error flag (Req 3.4). When true, the view renders the
   * "could not be loaded" message and a Retry button (if `onRetry` is given)
   * instead of journey detail.
   */
  error?: boolean;
  /**
   * Optional retry handler (Req 3.4). The parent (route search) wires this to
   * re-trigger the route search, since there is no separate detail fetch.
   */
  onRetry?: () => void;
}

/** Renders the fare for a single leg (only used for the economical selection). */
function LegFare({ leg }: { leg: Leg }): JSX.Element {
  if (leg.fare === null) {
    return (
      <span className="journey-detail__leg-fare journey-detail__leg-fare--missing">
        {DETAIL_MESSAGES.noFare}
      </span>
    );
  }
  return (
    <span className="journey-detail__leg-fare">
      ${formatAud(leg.fare.amountCents)}
      <span className="journey-detail__leg-fare-estimate"> (est.)</span>
    </span>
  );
}

/** A single leg row in the journey timeline. */
function LegRow({
  leg,
  index,
  showFare,
}: {
  leg: Leg;
  index: number;
  showFare: boolean;
}): JSX.Element {
  const routeLabel = leg.routeName ? `${formatMode(leg.mode)} · ${leg.routeName}` : formatMode(leg.mode);

  return (
    <li
      className={`journey-detail__leg journey-detail__leg--${leg.mode}${
        leg.isTransfer ? ' journey-detail__leg--transfer' : ''
      }`}
    >
      <div className="journey-detail__leg-mode">
        <span className={`journey-detail__mode-badge journey-detail__mode-badge--${leg.mode}`}>
          {routeLabel}
        </span>
        {leg.isTransfer && (
          <span className="journey-detail__transfer-tag">Transfer</span>
        )}
      </div>

      <div className="journey-detail__leg-stops">
        <div className="journey-detail__stop">
          <span className="journey-detail__stop-role">From</span>
          <span className="journey-detail__stop-name">
            {leg.origin.locationName}
          </span>
          <span className="journey-detail__stop-time">
            <time dateTime={leg.origin.time}>
              {formatClockTime(leg.origin.time)}
            </time>
            {leg.origin.platform && (
              <span className="journey-detail__platform">
                Platform {leg.origin.platform}
              </span>
            )}
          </span>
        </div>

        <div className="journey-detail__stop">
          <span className="journey-detail__stop-role">To</span>
          <span className="journey-detail__stop-name">
            {leg.destination.locationName}
          </span>
          <span className="journey-detail__stop-time">
            <time dateTime={leg.destination.time}>
              {formatClockTime(leg.destination.time)}
            </time>
            {leg.destination.platform && (
              <span className="journey-detail__platform">
                Platform {leg.destination.platform}
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="journey-detail__leg-meta">
        <span className="journey-detail__leg-duration">
          {formatDuration(leg.durationMinutes)}
        </span>
        {showFare && <LegFare leg={leg} />}
      </div>

      {/* Keep the index meaningful for assistive tech ordering. */}
      <span className="journey-detail__sr-only">Leg {index + 1}</span>
    </li>
  );
}

/** Renders the resolved journey detail (legs + summary). */
function JourneyDetail({
  journey,
  isEconomical,
}: {
  journey: Journey;
  isEconomical: boolean;
}): JSX.Element {
  return (
    <article className="journey-detail__content">
      <header className="journey-detail__summary">
        <div className="journey-detail__summary-times">
          <time dateTime={journey.departureTime}>
            {formatClockTime(journey.departureTime)}
          </time>
          <span className="journey-detail__summary-arrow" aria-hidden="true">
            →
          </span>
          <time dateTime={journey.arrivalTime}>
            {formatClockTime(journey.arrivalTime)}
          </time>
        </div>
        <dl className="journey-detail__summary-meta">
          <div>
            <dt>Travel time</dt>
            <dd>{formatDuration(journey.travelTimeMinutes)}</dd>
          </div>
          <div>
            <dt>Transfers</dt>
            <dd>{formatTransfers(journey.transferCount)}</dd>
          </div>
          {isEconomical && (
            <div>
              <dt>
                Total fare{' '}
                <span className="journey-detail__estimate-tag">(estimate)</span>
              </dt>
              <dd>
                {journey.totalFare === null
                  ? DETAIL_MESSAGES.noFare
                  : `$${formatAud(journey.totalFare.amountCents)}`}
              </dd>
            </div>
          )}
        </dl>
        {isEconomical && (
          <p className="journey-detail__fare-note" role="note">
            {DETAIL_MESSAGES.fareEstimateDetail}
          </p>
        )}
      </header>

      <ol className="journey-detail__legs" aria-label="Journey legs">
        {journey.legs.map((leg, index) => (
          <LegRow
            key={`${leg.departureTime}-${index}`}
            leg={leg}
            index={index}
            showFare={isEconomical}
          />
        ))}
      </ol>
    </article>
  );
}

/**
 * Renders the full leg-by-leg detail for an already-fetched journey, with an
 * optional prop-driven retry action when the route search failed
 * (Req 3.2, 4.2, 5.5, 3.4). This component does no fetching of its own.
 */
export function JourneyDetailView({
  journey,
  isEconomical = false,
  error = false,
  onRetry,
}: JourneyDetailViewProps): JSX.Element {
  return (
    <section className="journey-detail" aria-label="Journey details">
      {error ? (
        <div
          className="journey-detail__message journey-detail__message--error"
          role="alert"
        >
          <p className="journey-detail__error-text">{DETAIL_MESSAGES.error}</p>
          {onRetry && (
            <button
              type="button"
              className="journey-detail__retry"
              onClick={onRetry}
            >
              {DETAIL_MESSAGES.retry}
            </button>
          )}
        </div>
      ) : journey ? (
        <JourneyDetail journey={journey} isEconomical={isEconomical} />
      ) : (
        <p className="journey-detail__message" role="status" aria-live="polite">
          {DETAIL_MESSAGES.empty}
        </p>
      )}
    </section>
  );
}
