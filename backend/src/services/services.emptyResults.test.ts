import { describe, it, expect } from 'vitest';

import type {
  Journey,
  Location,
  RouteRequest,
  SelectableMode,
} from '../domain/models.js';
import {
  DefaultLocationService,
  type StopFinderClient,
} from './locationService.js';
import {
  RouteService,
  type RoutePlanningClient,
} from './routeService.js';

// Feature: tfnsw-route-planner, Task 8.5: unit tests for empty-result behaviours.
//
// Validates:
//   - Requirement 1.4: a valid (>=3 char) location query that yields no
//     matches resolves to an empty list, which drives the frontend's
//     "no locations found" state.
//   - Requirement 2.4: a valid trip request (distinct origin/destination) that
//     yields no journeys resolves to a RouteResult with no journeys, null
//     fastest/economical ids, and a comparison whose fastest/economical sides
//     are null — driving the frontend's "no routes found" state.
//
// Both services are exercised with lightweight FAKE injected clients (no real
// I/O), per the dependency-injection seam designed into each service.

/**
 * Fake stop-finder client that always returns an empty match list, regardless
 * of the query. Records the queries it was asked for so the test can assert the
 * upstream was actually consulted for a >=3 char query.
 */
class EmptyStopFinderClient implements StopFinderClient {
  public readonly queries: string[] = [];

  public stopFinder(query: string): Promise<Location[]> {
    this.queries.push(query);
    return Promise.resolve([]);
  }
}

/**
 * Fake trip client that always returns an empty journey list, regardless of the
 * arguments. Records the calls so the test can assert the client WAS invoked
 * (the request was valid and reached the upstream seam).
 */
class EmptyTripClient implements RoutePlanningClient {
  public readonly calls: Array<{
    originId: string;
    destinationId: string;
    time: Date;
    depArr: 'dep' | 'arr';
    calcNumberOfTrips?: number;
    excludedModes?: SelectableMode[];
  }> = [];

  public trip(params: {
    originId: string;
    destinationId: string;
    time: Date;
    depArr: 'dep' | 'arr';
    calcNumberOfTrips?: number;
    excludedModes?: SelectableMode[];
  }): Promise<Journey[]> {
    this.calls.push(params);
    return Promise.resolve([]);
  }
}

describe('DefaultLocationService.searchLocations - empty match list (Req 1.4)', () => {
  it('resolves to an empty array when a valid query returns no matches', async () => {
    const client = new EmptyStopFinderClient();
    const service = new DefaultLocationService(client);

    const result = await service.searchLocations('Central');

    // Empty result drives the "no locations found" UI state.
    expect(result).toEqual([]);
    // The query was >=3 chars, so the upstream client SHOULD have been consulted
    // (this is a genuine "no matches" result, not the short-query guard).
    expect(client.queries).toEqual(['Central']);
  });

  it('resolves to an empty array for a minimal 3-character query with no matches', async () => {
    const client = new EmptyStopFinderClient();
    const service = new DefaultLocationService(client);

    const result = await service.searchLocations('xyz');

    expect(result).toEqual([]);
    expect(client.queries).toEqual(['xyz']);
  });
});

describe('RouteService.planRoutes - empty journey list (Req 2.4)', () => {
  it('resolves to an empty RouteResult when a valid request returns no journeys', async () => {
    const client = new EmptyTripClient();
    const service = new RouteService(client);

    const request: RouteRequest = {
      originId: 'STOP_A',
      destinationId: 'STOP_B',
      time: '2025-01-15T08:00:00+11:00',
      depArr: 'dep',
      // All seven selectable modes => "no exclusion" (include everything).
      includedModes: [
        'train',
        'metro',
        'lightRail',
        'bus',
        'coach',
        'ferry',
        'school',
      ],
    };

    const result = await service.planRoutes(request);

    // No journeys -> "no routes found" UI state.
    expect(result.journeys).toEqual([]);
    expect(result.fastestId).toBeNull();
    expect(result.economicalId).toBeNull();

    // Comparison has no sides to compare.
    expect(result.comparison.fastest).toBeNull();
    expect(result.comparison.economical).toBeNull();
    expect(result.comparison.sameRoute).toBe(false);
    expect(result.comparison.travelTimeDifferenceMinutes).toBeNull();
    expect(result.comparison.fareDifferenceCents).toBeNull();
    expect(result.comparison.fasterRouteId).toBeNull();
    expect(result.comparison.cheaperRouteId).toBeNull();
    expect(result.comparison.fareUnavailableForFastest).toBe(false);

    // The request was valid (distinct origin/destination), so the upstream trip
    // client WAS invoked. RouteService now issues TWO queries (forward +
    // opposite direction) to build the earlier+later window, so the client is
    // called twice.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.originId).toBe('STOP_A');
    expect(client.calls[0]?.destinationId).toBe('STOP_B');
    // The two queries cover both directions around the Selected_Time.
    const depArrValues = client.calls.map((c) => c.depArr).sort();
    expect(depArrValues).toEqual(['arr', 'dep']);
  });
});
