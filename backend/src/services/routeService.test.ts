import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { RouteService, type RoutePlanningClient } from './routeService.js';
import { ValidationError } from '../domain/errors.js';
import type { Journey } from '../domain/models.js';

// Feature: tfnsw-route-planner, Property 6: Identical origin and destination are rejected
//
// Validates: Requirements 2.5
//
// For ANY location id string, calling `RouteService.planRoutes` with that id as
// BOTH the origin and the destination must:
//   1. reject with a `ValidationError`, AND
//   2. NOT invoke the injected client's `trip` method (call count 0).
//
// The validation guard runs BEFORE any upstream call, so a request that cannot
// produce a meaningful route never reaches (and never burns quota against) the
// rate-limited TfNSW API. To prove the client is untouched, we inject a spying
// fake `RoutePlanningClient` that records every `trip` invocation and would also
// resolve with journeys if called — so a missing rejection would surface as a
// resolved promise rather than a silent pass.

/**
 * A spying fake `RoutePlanningClient`. It counts `trip` calls and, if ever
 * invoked, resolves with an empty journey list (it must never be called for the
 * identical origin/destination case).
 */
class SpyRoutePlanningClient implements RoutePlanningClient {
  public tripCallCount = 0;

  public async trip(): Promise<Journey[]> {
    this.tripCallCount += 1;
    return [];
  }
}

/**
 * Arbitrary location id string. Covers empty, whitespace, unicode, and ordinary
 * id-like strings so the property holds across the full id input space.
 */
const ID_ARB: fc.Arbitrary<string> = fc.string({ maxLength: 40 });

/** Arbitrary time string (ISO-ish and arbitrary free text, including empty). */
const TIME_ARB: fc.Arbitrary<string> = fc.oneof(
  fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }).map((d) => d.toISOString()),
  fc.string({ maxLength: 30 }),
);

describe('RouteService.planRoutes identical origin/destination rejection (Property 6)', () => {
  it('rejects with ValidationError and never invokes the client for any id', async () => {
    await fc.assert(
      fc.asyncProperty(ID_ARB, TIME_ARB, async (id, time) => {
        const client = new SpyRoutePlanningClient();
        const service = new RouteService(client);

        await expect(
          service.planRoutes({ originId: id, destinationId: id, time }),
        ).rejects.toBeInstanceOf(ValidationError);

        // The upstream client must never be touched for an invalid request.
        expect(client.tripCallCount).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  // --- Concrete anchoring examples -----------------------------------------

  it('rejects an ordinary identical id without calling the client', async () => {
    const client = new SpyRoutePlanningClient();
    const service = new RouteService(client);

    await expect(
      service.planRoutes({
        originId: 'G10111',
        destinationId: 'G10111',
        time: '2025-01-01T09:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.tripCallCount).toBe(0);
  });

  it('rejects an empty identical id without calling the client', async () => {
    const client = new SpyRoutePlanningClient();
    const service = new RouteService(client);

    await expect(
      service.planRoutes({ originId: '', destinationId: '', time: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.tripCallCount).toBe(0);
  });
});
