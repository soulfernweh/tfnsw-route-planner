// RouteList — TripView-style departure-board layout for journey results.
//
// Renders a dense, flat list of departure rows with a live countdown badge on
// the left, platform/destination/line info, departure→arrival times, and
// real-time status. The fastest/economical badges are compact inline tags.
//
// Props/data interface is UNCHANGED from the original card-based layout — this
// is a pure visual restyle.

import type { Journey, TransportMode } from '../api/types';
import { useCountdown } from '../hooks/useCountdown';
import type { CountdownStatus } from '../hooks/useCountdown';
import {
  formatClockTime12h,
  formatCountdown,
  formatMode,
  formatTravelTime,
  formatTransfers,
} from './routeFormat';
import '../styles/routes.css';

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

/** Orders the full window of journeys by non-decreasing departure time. */
function orderedRoutes(journeys: Journey[]): Journey[] {
  return [...journeys].sort(
    (a, b) =>
      new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime(),
  );
}

/** Maps countdown status to the CSS modifier class. */
function countdownModifier(status: CountdownStatus): string {
  switch (status) {
    case 'imminent':
      return 'departure-row__countdown--imminent';
    case 'soon':
      return 'departure-row__countdown--soon';
    case 'later':
      return 'departure-row__countdown--later';
    case 'past':
      return 'departure-row__countdown--past';
  }
}

/** Extracts the platform from the first leg's origin, if available. */
function getPlatform(journey: Journey): string | null {
  return journey.legs[0]?.origin.platform ?? null;
}

/** Gets the final destination name (last leg's destination). */
function getDestinationName(journey: Journey): string {
  const lastLeg = journey.legs[journey.legs.length - 1];
  return lastLeg?.destination.locationName ?? '';
}

/**
 * Gets the line code from the first vehicle (non-transfer) leg's routeName,
 * or falls back to the mode label.
 */
function getLineCode(journey: Journey): string {
  const vehicleLeg = journey.legs.find((leg) => !leg.isTransfer);
  if (vehicleLeg?.routeName) {
    return vehicleLeg.routeName;
  }
  if (vehicleLeg) {
    return formatMode(vehicleLeg.mode);
  }
  return formatMode(journey.modes[0] ?? 'other');
}

/** Gets the primary mode for CSS colouring. */
function getPrimaryMode(journey: Journey): TransportMode {
  const vehicleLeg = journey.legs.find((leg) => !leg.isTransfer);
  return vehicleLeg?.mode ?? journey.modes[0] ?? 'other';
}

/** The live countdown badge component. */
function CountdownBadge({
  departureTime,
}: {
  departureTime: string;
}): JSX.Element {
  const { minutes, status } = useCountdown(departureTime);
  const label = formatCountdown(minutes);
  const modifier = countdownModifier(status);

  return (
    <div className={`departure-row__countdown ${modifier}`} aria-label={`Departing in ${label}`}>
      <span className="departure-row__countdown-value">{label}</span>
    </div>
  );
}

/** A single departure-board row. */
function DepartureRow({
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
  const platform = getPlatform(journey);
  const destination = getDestinationName(journey);
  const lineCode = getLineCode(journey);
  const primaryMode = getPrimaryMode(journey);

  const badgeLabels: string[] = [];
  if (isFastest) badgeLabels.push('fastest');
  if (isEconomical) badgeLabels.push('most economical');
  const accessibleSummary =
    badgeLabels.length > 0 ? ` (${badgeLabels.join(' and ')} route)` : '';

  const content = (
    <>
      {/* Left: countdown badge */}
      <CountdownBadge departureTime={journey.departureTime} />

      {/* Body */}
      <div className="departure-row__body">
        {/* Top line: platform + destination + line code */}
        <div className="departure-row__header">
          <div className="departure-row__route-info">
            {platform && (
              <span className="departure-row__platform">
                Platform {platform}
              </span>
            )}
            <span className="departure-row__destination">{destination}</span>
          </div>
          <span
            className={`departure-row__line-code departure-row__line-code--${primaryMode}`}
          >
            {lineCode}
          </span>
        </div>

        {/* Second line: departure → arrival times */}
        <div className="departure-row__times">
          <time className="departure-row__time" dateTime={journey.departureTime}>
            {formatClockTime12h(journey.departureTime)}
          </time>
          <span className="departure-row__arrow" aria-hidden="true">→</span>
          <time className="departure-row__time" dateTime={journey.arrivalTime}>
            {formatClockTime12h(journey.arrivalTime)}
          </time>
          <span className="departure-row__duration">
            {formatTravelTime(journey.travelTimeMinutes)}
            {journey.transferCount > 0 && (
              <> · {formatTransfers(journey.transferCount)}</>
            )}
          </span>
        </div>

        {/* Third line: real-time status + inline icon badges */}
        <div className="departure-row__status-line">
          <span className="departure-row__realtime departure-row__realtime--ontime">
            On time
          </span>

          {(isFastest || isEconomical) && (
            <span className="departure-row__badges">
              {isFastest && (
                <span className="departure-row__badge departure-row__badge--fastest" title="Fastest route">
                  ⚡ Fastest
                </span>
              )}
              {isEconomical && (
                <span className="departure-row__badge departure-row__badge--economical" title="Most economical route">
                  💰 Cheapest
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </>
  );

  if (onSelect) {
    return (
      <li>
        <button
          type="button"
          className="departure-row departure-row--interactive"
          onClick={() => onSelect(journey)}
          aria-label={`Route departing ${formatClockTime12h(
            journey.departureTime,
          )}, arriving ${formatClockTime12h(
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
    <li
      className="departure-row"
      aria-label={`Route${accessibleSummary}`}
    >
      {content}
    </li>
  );
}

/**
 * Renders the ranked list of routes as a departure board. Returns nothing when
 * there are no journeys; the empty-state messaging is owned by
 * {@link RouteSearchController}.
 */
export function RouteList({
  journeys,
  fastestId,
  economicalId,
  onSelect,
}: RouteListProps): JSX.Element | null {
  const routes = orderedRoutes(journeys);
  if (routes.length === 0) {
    return null;
  }

  return (
    <ul className="route-list" aria-label="Available routes">
      {routes.map((journey) => (
        <DepartureRow
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
