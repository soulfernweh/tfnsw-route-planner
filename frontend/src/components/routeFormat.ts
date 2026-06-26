// Small, local presentation helpers for the route list / search views.
//
// These are deliberately self-contained (no cross-package imports) so this
// component does not couple to work happening in parallel. AUD currency
// formatting for the comparison view lives in the shared package (task 2.1);
// the route list only needs clock times, durations, transfers, and mode
// labels, which are formatted here.

import type { TransportMode } from '../api/types';

/**
 * Formats an ISO 8601 timestamp as a local wall-clock time (e.g. "08:05").
 * Falls back to the raw string if it cannot be parsed, so we never render
 * "Invalid Date" to users.
 */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Formats a non-negative whole-minute duration as hours and minutes
 * (e.g. 65 -> "1h 5m", 45 -> "45m", 0 -> "0m"). Negative or non-finite
 * inputs are clamped to zero.
 */
export function formatTravelTime(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${mins}m`;
}

/**
 * Renders a transfer count as accessible, human-readable text.
 * 0 -> "Direct", 1 -> "1 transfer", n -> "n transfers".
 */
export function formatTransfers(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  if (safe === 0) {
    return 'Direct';
  }
  return `${safe} transfer${safe === 1 ? '' : 's'}`;
}

/** Human-friendly labels for each transport mode. */
const MODE_LABELS: Record<TransportMode, string> = {
  train: 'Train',
  metro: 'Metro',
  bus: 'Bus',
  ferry: 'Ferry',
  lightRail: 'Light Rail',
  coach: 'Coach',
  walk: 'Walk',
  school: 'School Bus',
  other: 'Other',
};

/** Returns the display label for a single transport mode. */
export function formatMode(mode: TransportMode): string {
  return MODE_LABELS[mode] ?? 'Other';
}
