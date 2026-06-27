// useCountdown — live countdown hook for departure-board display.
//
// Returns the minutes remaining until a given ISO timestamp, ticking every
// second, and a status string for colour-coding the countdown badge.

import { useEffect, useState } from 'react';

export type CountdownStatus = 'imminent' | 'soon' | 'later' | 'past';

export interface CountdownResult {
  /** Minutes remaining (floored). Negative when departure is in the past. */
  minutes: number;
  /** Status bucket for colour-coding. */
  status: CountdownStatus;
}

/** Compute minutes remaining and status from a target ISO time. */
function computeCountdown(targetIso: string): CountdownResult {
  const diff = new Date(targetIso).getTime() - Date.now();
  const minutes = Math.floor(diff / 60_000);

  let status: CountdownStatus;
  if (minutes < 0) {
    status = 'past';
  } else if (minutes <= 5) {
    status = 'imminent';
  } else if (minutes <= 15) {
    status = 'soon';
  } else {
    status = 'later';
  }

  return { minutes, status };
}

/**
 * Hook that returns a live countdown to the given ISO timestamp.
 * Ticks every 15 seconds to keep the departure board current without
 * excessive re-renders.
 */
export function useCountdown(targetIso: string): CountdownResult {
  const [result, setResult] = useState<CountdownResult>(() =>
    computeCountdown(targetIso),
  );

  useEffect(() => {
    // Immediately recompute in case targetIso changed.
    setResult(computeCountdown(targetIso));

    const id = setInterval(() => {
      setResult(computeCountdown(targetIso));
    }, 15_000);

    return () => clearInterval(id);
  }, [targetIso]);

  return result;
}
