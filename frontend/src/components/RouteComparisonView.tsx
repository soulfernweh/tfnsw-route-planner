// RouteComparisonView — side-by-side comparison of the fastest vs the most
// economical route (Requirement 5).
//
// Given a `RouteComparison` (and the journeys from the route result, so a
// selection can surface the full `Journey`), this component:
//   - shows, for each route, total travel time (h/m), total estimated fare in
//     AUD to two decimals — clearly labelled as an ESTIMATE — the number of
//     transfers, and the transport modes used (Req 5.2);
//   - shows the travel-time difference (minutes) and the fare difference (AUD)
//     with faster/cheaper labels (Req 5.3);
//   - collapses to a single route when the fastest and economical routes
//     coincide, indicating it is both fastest and most economical (Req 5.4);
//   - when the fastest route has no fare data, shows a notice and compares on
//     travel time + transfers only (Req 5.6);
//   - surfaces the chosen route through `onSelect` so the parent can show the
//     JourneyDetailView (Req 5.5).
//
// Formatting reuses the shared helpers (`formatAud`, `formatDuration`) so the
// comparison renders currency and durations exactly as the rest of the app.
//
// Mobile-first & accessible: the two routes stack as full-width cards on phones
// and sit side by side from the tablet breakpoint up. Faster/cheaper status is
// conveyed with text labels (not colour alone), and each route is selectable
// via a real, focusable button when `onSelect` is provided.

import { formatAud, formatDuration } from '@tfnsw/shared';
import type {
  ComparisonEntry,
  Journey,
  RouteComparison,
  TransportMode,
} from '../api/types';
import { formatMode, formatTransfers } from './routeFormat';
import './RouteComparisonView.css';

/** User-facing copy (kept here so tests and UI share a single source). */
export const COMPARISON_MESSAGES = {
  heading: 'Compare routes',
  fastestLabel: 'Fastest route',
  economicalLabel: 'Most economical route',
  bothLabel: 'Fastest and most economical',
  fareEstimate: 'estimate',
  fareUnavailable: 'Fare estimate not available',
  fareUnavailableNotice:
    'Fare data is unavailable for the fastest route. Comparing on travel time and transfers only.',
  travelTimeDiffLabel: 'Travel time difference',
  fareDiffLabel: 'Fare difference',
  fasterTag: 'Faster',
  cheaperTag: 'Cheaper',
  unavailable: 'Unavailable to compare',
  empty: 'A comparison will appear once both routes are identified.',
  viewDetails: 'View details',
} as const;

export interface RouteComparisonViewProps {
  /** The fastest-vs-economical comparison from the route result. */
  comparison: RouteComparison;
  /**
   * The journeys from the route result, used to resolve a `ComparisonEntry`
   * back to its full `Journey` when the user selects a route (Req 5.5).
   */
  journeys: Journey[];
  /**
   * Invoked with the full journey when a route is selected, so the parent can
   * render the JourneyDetailView (Req 5.5).
   */
  onSelect?: (journey: Journey) => void;
}

/** Renders the ordered transport modes used by a route. */
function ModeList({ modes }: { modes: TransportMode[] }): JSX.Element {
  if (modes.length === 0) {
    return (
      <span className="comparison-card__mode comparison-card__mode--empty">
        —
      </span>
    );
  }
  return (
    <span className="comparison-card__modes">
      {modes.map((mode, index) => (
        <span
          key={`${mode}-${index}`}
          className={`comparison-card__mode comparison-card__mode--${mode}`}
        >
          {formatMode(mode)}
        </span>
      ))}
    </span>
  );
}

/** Renders the fare for a route entry, labelled as an estimate (Req 5.2). */
function EntryFare({ entry }: { entry: ComparisonEntry }): JSX.Element {
  if (entry.totalFare === null) {
    return (
      <dd className="comparison-card__fare comparison-card__fare--missing">
        {COMPARISON_MESSAGES.fareUnavailable}
      </dd>
    );
  }
  return (
    <dd className="comparison-card__fare">
      ${formatAud(entry.totalFare.amountCents)}{' '}
      <span className="comparison-card__estimate-tag">
        ({COMPARISON_MESSAGES.fareEstimate})
      </span>
    </dd>
  );
}

/** The inner content of a route card (travel time, fare, transfers, modes). */
function EntryBody({
  entry,
  showFare,
}: {
  entry: ComparisonEntry;
  showFare: boolean;
}): JSX.Element {
  return (
    <dl className="comparison-card__meta">
      <div className="comparison-card__meta-item">
        <dt>Travel time</dt>
        <dd>{formatDuration(entry.travelTimeMinutes)}</dd>
      </div>
      {showFare ? (
        <div className="comparison-card__meta-item">
          <dt>
            Total fare{' '}
            <span className="comparison-card__estimate-tag">(estimate)</span>
          </dt>
          <EntryFare entry={entry} />
        </div>
      ) : (
        <div className="comparison-card__meta-item">
          <dt>Total fare</dt>
          <dd className="comparison-card__fare comparison-card__fare--missing">
            {COMPARISON_MESSAGES.fareUnavailable}
          </dd>
        </div>
      )}
      <div className="comparison-card__meta-item">
        <dt>Transfers</dt>
        <dd>{formatTransfers(entry.transferCount)}</dd>
      </div>
      <div className="comparison-card__meta-item comparison-card__meta-item--modes">
        <dt>Modes</dt>
        <dd>
          <ModeList modes={entry.modes} />
        </dd>
      </div>
    </dl>
  );
}

/**
 * A single route card. Renders as a selectable button when `onSelect` and a
 * matching journey are available, otherwise as a static region.
 */
function RouteCard({
  entry,
  roleLabel,
  tags,
  showFare,
  journey,
  onSelect,
}: {
  entry: ComparisonEntry;
  roleLabel: string;
  tags: string[];
  showFare: boolean;
  journey: Journey | undefined;
  onSelect?: (journey: Journey) => void;
}): JSX.Element {
  const header = (
    <div className="comparison-card__header">
      <h4 className="comparison-card__role">{roleLabel}</h4>
      {tags.length > 0 && (
        <div className="comparison-card__tags" aria-hidden="true">
          {tags.map((tag) => (
            <span
              key={tag}
              className={`comparison-tag comparison-tag--${tag.toLowerCase()}`}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  const tagSummary = tags.length > 0 ? ` (${tags.join(' and ')})` : '';

  if (onSelect && journey) {
    return (
      <li className="comparison-card-item">
        <button
          type="button"
          className="comparison-card comparison-card--interactive"
          onClick={() => onSelect(journey)}
          aria-label={`${roleLabel}${tagSummary}: ${formatDuration(
            entry.travelTimeMinutes,
          )}, ${formatTransfers(entry.transferCount)}. ${
            COMPARISON_MESSAGES.viewDetails
          }.`}
        >
          {header}
          <EntryBody entry={entry} showFare={showFare} />
          <span className="comparison-card__cta" aria-hidden="true">
            {COMPARISON_MESSAGES.viewDetails}
          </span>
        </button>
      </li>
    );
  }

  return (
    <li className="comparison-card-item">
      <div className="comparison-card" aria-label={`${roleLabel}${tagSummary}`}>
        {header}
        <EntryBody entry={entry} showFare={showFare} />
      </div>
    </li>
  );
}

/**
 * Renders the travel-time and fare differences with faster/cheaper labelling
 * (Req 5.3). When the fastest route has no fare, the fare difference is omitted
 * and only the travel-time difference is shown (Req 5.6).
 */
function DifferenceSummary({
  comparison,
}: {
  comparison: RouteComparison;
}): JSX.Element {
  const { travelTimeDifferenceMinutes, fareDifferenceCents } = comparison;

  const fasterIsFastest =
    comparison.fasterRouteId !== null &&
    comparison.fasterRouteId === comparison.fastest?.journeyId;
  const cheaperIsEconomical =
    comparison.cheaperRouteId !== null &&
    comparison.cheaperRouteId === comparison.economical?.journeyId;

  return (
    <dl className="comparison-diff" aria-label="Differences between routes">
      <div className="comparison-diff__item">
        <dt>{COMPARISON_MESSAGES.travelTimeDiffLabel}</dt>
        <dd>
          {travelTimeDifferenceMinutes === null ? (
            COMPARISON_MESSAGES.unavailable
          ) : (
            <>
              {formatDuration(travelTimeDifferenceMinutes)}
              <span className="comparison-diff__note">
                {' '}
                {fasterIsFastest
                  ? `${COMPARISON_MESSAGES.fastestLabel} is faster`
                  : `${COMPARISON_MESSAGES.economicalLabel} is faster`}
              </span>
            </>
          )}
        </dd>
      </div>
      <div className="comparison-diff__item">
        <dt>{COMPARISON_MESSAGES.fareDiffLabel}</dt>
        <dd>
          {fareDifferenceCents === null ? (
            COMPARISON_MESSAGES.unavailable
          ) : (
            <>
              ${formatAud(fareDifferenceCents)}
              <span className="comparison-diff__note">
                {' '}
                {cheaperIsEconomical
                  ? `${COMPARISON_MESSAGES.economicalLabel} is cheaper`
                  : `${COMPARISON_MESSAGES.fastestLabel} is cheaper`}
              </span>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Side-by-side fastest vs economical comparison. Collapses to a single route
 * when the two coincide (Req 5.4) and handles the missing-fare notice for the
 * fastest route (Req 5.6).
 */
export function RouteComparisonView({
  comparison,
  journeys,
  onSelect,
}: RouteComparisonViewProps): JSX.Element | null {
  const { fastest, economical } = comparison;

  // Req 5.1: the comparison is shown once both routes are identified. If we
  // lack the data to compare, render nothing rather than a broken view.
  if (!fastest) {
    return null;
  }

  const findJourney = (journeyId: string): Journey | undefined =>
    journeys.find((journey) => journey.id === journeyId);

  // Req 5.4: the fastest and economical routes are the same journey — collapse
  // to a single route and indicate it is both.
  if (comparison.sameRoute || !economical) {
    const showFare = !comparison.fareUnavailableForFastest;
    return (
      <section className="comparison" aria-label="Route comparison">
        <h3 className="comparison__heading">{COMPARISON_MESSAGES.heading}</h3>
        {comparison.fareUnavailableForFastest && (
          <p className="comparison__notice" role="note">
            {COMPARISON_MESSAGES.fareUnavailableNotice}
          </p>
        )}
        <ul className="comparison__routes comparison__routes--single">
          <RouteCard
            entry={fastest}
            roleLabel={COMPARISON_MESSAGES.bothLabel}
            tags={[COMPARISON_MESSAGES.fasterTag, COMPARISON_MESSAGES.cheaperTag]}
            showFare={showFare}
            journey={findJourney(fastest.journeyId)}
            {...(onSelect ? { onSelect } : {})}
          />
        </ul>
      </section>
    );
  }

  // Two distinct routes. Req 5.6: when the fastest route's fare is unavailable,
  // show a notice and compare on travel time + transfers only.
  const fareUnavailable = comparison.fareUnavailableForFastest;
  const fastestTags: string[] = [COMPARISON_MESSAGES.fasterTag];
  const economicalTags: string[] = [];
  if (!fareUnavailable) {
    economicalTags.push(COMPARISON_MESSAGES.cheaperTag);
  }

  return (
    <section className="comparison" aria-label="Route comparison">
      <h3 className="comparison__heading">{COMPARISON_MESSAGES.heading}</h3>
      {fareUnavailable && (
        <p className="comparison__notice" role="note">
          {COMPARISON_MESSAGES.fareUnavailableNotice}
        </p>
      )}

      <ul className="comparison__routes">
        <RouteCard
          entry={fastest}
          roleLabel={COMPARISON_MESSAGES.fastestLabel}
          tags={fastestTags}
          showFare={!fareUnavailable}
          journey={findJourney(fastest.journeyId)}
          {...(onSelect ? { onSelect } : {})}
        />
        <RouteCard
          entry={economical}
          roleLabel={COMPARISON_MESSAGES.economicalLabel}
          tags={economicalTags}
          showFare
          journey={findJourney(economical.journeyId)}
          {...(onSelect ? { onSelect } : {})}
        />
      </ul>

      <DifferenceSummary comparison={comparison} />
    </section>
  );
}
