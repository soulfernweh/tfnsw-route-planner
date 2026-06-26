// RouteList — renders up to 5 discovered routes for a search (Req 2.2, 2.3).
//
// Each route shows its departure time, arrival time, total travel time, number
// of transfers, and the transport modes used. The fastest and the most
// economical routes are visually badged/highlighted using the `fastestId` and
// `economicalId` carried on the RouteResult (Req 3.1, 4.1).
//
// Mobile-first: routes stack as full-width cards on phones and flow naturally
// on larger screens via the shared route styles.

import type { Journey, TransportMode } from '../api/types';
import {
  formatClockTime,
  formatMode,
  formatTransfers,
  formatTravelTime,
} from './routeFormat';
import '../styles/routes.css';

/** The maximum number of routes the design surfaces for a single search. */
const MAX_ROUTES = 5;

export interface RouteListProps {
  /** Discovered journeys (already ranked/ordered by the backend). */
  journeys: Journey[];
  /** Id of the fastest journey, for badging. */
  fastestId: string | null;
  /** Id of the most economical journey, for badging. */
  economicalId: string | null;
  /** Invoked when the user activates a route (for the detail view, task 11.6). */
  onSelect?: (journey: Journey) => void;
}

/** Orders journeys by non-decreasing departure time and caps at 5. */
function orderedTopRoutes(journeys: Journey[]): Journey[] {
  return [...journeys]
    .sort(
      (a, b) =>
        new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime(),
    )
    .slice(0, MAX_ROUTES);
}

/** Renders the ordered, comma-free list of transport modes for a journey. */
function ModeList({ modes }: { modes: TransportMode[] }): JSX.Element {
  if (modes.length === 0) {
    return <span className="route-card__mode route-card__mode--empty">—</span>;
  }
  return (
    <span className="route-card__modes">
      {modes.map((mode, index) => (
        <span
          key={`${mode}-${index}`}
          className={`route-card__mode route-card__mode--${mode}`}
        >
          {formatMode(mode)}
        </span>
      ))}
    </span>
  );
}

/** A single route card. */
function RouteCard({
  journey,
  isFastest,
  isEconomical,
  onSelect,
}: {
  journey: Journey;
  isFastest: boolean;
  isEconomical: boolean;
  onSelect?: (journey: Journey) => void;
}): JSX.Element {
  const classNames = [
    'route-card',
    isFastest ? 'route-card--fastest' : '',
    isEconomical ? 'route-card--economical' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const badgeLabels: string[] = [];
  if (isFastest) badgeLabels.push('fastest');
  if (isEconomical) badgeLabels.push('most economical');
  const accessibleSummary =
    badgeLabels.length > 0 ? ` (${badgeLabels.join(' and ')} route)` : '';

  const content = (
    <>
      {(isFastest || isEconomical) && (
        <div className="route-card__badges" aria-hidden="true">
          {isFastest && (
            <span className="route-badge route-badge--fastest">Fastest</span>
          )}
          {isEconomical && (
            <span className="route-badge route-badge--economical">
              Most economical
            </span>
          )}
        </div>
      )}

      <div className="route-card__times">
        <span className="route-card__time">
          <span className="route-card__time-label">Depart</span>
          <time dateTime={journey.departureTime}>
            {formatClockTime(journey.departureTime)}
          </time>
        </span>
        <span className="route-card__arrow" aria-hidden="true">
          →
        </span>
        <span className="route-card__time">
          <span className="route-card__time-label">Arrive</span>
          <time dateTime={journey.arrivalTime}>
            {formatClockTime(journey.arrivalTime)}
          </time>
        </span>
      </div>

      <dl className="route-card__meta">
        <div className="route-card__meta-item">
          <dt>Travel time</dt>
          <dd>{formatTravelTime(journey.travelTimeMinutes)}</dd>
        </div>
        <div className="route-card__meta-item">
          <dt>Transfers</dt>
          <dd>{formatTransfers(journey.transferCount)}</dd>
        </div>
        <div className="route-card__meta-item route-card__meta-item--modes">
          <dt>Modes</dt>
          <dd>
            <ModeList modes={journey.modes} />
          </dd>
        </div>
      </dl>
    </>
  );

  if (onSelect) {
    return (
      <li>
        <button
          type="button"
          className={`${classNames} route-card--interactive`}
          onClick={() => onSelect(journey)}
          aria-label={`Route departing ${formatClockTime(
            journey.departureTime,
          )}, arriving ${formatClockTime(
            journey.arrivalTime,
          )}, ${formatTravelTime(journey.travelTimeMinutes)}, ${formatTransfers(
            journey.transferCount,
          )}${accessibleSummary}. View details.`}
        >
          {content}
        </button>
      </li>
    );
  }

  return (
    <li className={classNames} aria-label={`Route${accessibleSummary}`}>
      {content}
    </li>
  );
}

/**
 * Renders the ranked list of routes. Returns nothing when there are no
 * journeys; the empty-state messaging is owned by {@link RouteSearchController}.
 */
export function RouteList({
  journeys,
  fastestId,
  economicalId,
  onSelect,
}: RouteListProps): JSX.Element | null {
  const routes = orderedTopRoutes(journeys);
  if (routes.length === 0) {
    return null;
  }

  return (
    <ul className="route-list" aria-label="Available routes">
      {routes.map((journey) => (
        <RouteCard
          key={journey.id}
          journey={journey}
          isFastest={journey.id === fastestId}
          isEconomical={journey.id === economicalId}
          {...(onSelect ? { onSelect } : {})}
        />
      ))}
    </ul>
  );
}
