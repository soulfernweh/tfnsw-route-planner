import { describe, it, expect } from 'vitest';

import { estimateLegFare } from './opalFareCalculator.js';
import opalFares from './data/opalFares.json';
import type { TransportMode } from '../domain/models.js';

// Feature: tfnsw-route-planner, Task 5.8: Example-based test for the Opal fare
// calculator's distance-band boundaries.
//
// Validates: Requirements 4.3 (compute per-leg Opal fare from distance + mode),
// 4.5 (fares are estimates derived from reconcilable config tables).
//
// These are EXAMPLE-based assertions (not a universal property): they pin the
// exact band-boundary behaviour documented on `estimateLegFare` and in
// `opalFares.json` — a distance falls into the FIRST band whose
// `maxDistanceMetres` is `null` OR is `>=` the distance (upper edge inclusive).
//
// Expectations are DERIVED from `opalFares.json` for the band-mapping
// assertions so the test stays in sync if the seeded data changes, with a few
// explicit literal checks that mirror the current published seed values.

// --- Typed view of the seeded config --------------------------------------

interface SeedBand {
  maxDistanceMetres: number | null;
  fareCents: number;
}
interface SeedConfig {
  currency: 'AUD';
  modeToTable: Record<string, string>;
  tables: Record<string, SeedBand[]>;
}
const seed = opalFares as unknown as SeedConfig;

/**
 * Reference implementation of the documented band-mapping rule, used ONLY to
 * derive expected fares from the seeded JSON. Intentionally mirrors the
 * convention in prose so the test verifies `estimateLegFare` against an
 * independent reading of the data.
 */
function expectedFareCents(tableName: string, distanceMetres: number): number {
  const bands = seed.tables[tableName];
  for (const band of bands) {
    if (band.maxDistanceMetres === null || distanceMetres <= band.maxDistanceMetres) {
      return band.fareCents;
    }
  }
  throw new Error(`no band matched ${distanceMetres}m in table ${tableName}`);
}

/**
 * For each band in a table, return representative sample distances that exercise
 * the boundary convention:
 *  - the lower edge of the band (one past the previous band's upper edge, or 0),
 *  - the exact upper edge (inclusive) for finite bands,
 *  - a representative point inside the open-ended top band.
 */
function boundarySamples(tableName: string): number[] {
  const bands = seed.tables[tableName];
  const samples: number[] = [];
  let prevEdge = -1;
  for (const band of bands) {
    const lower = prevEdge + 1 < 0 ? 0 : prevEdge + 1;
    samples.push(Math.max(0, lower));
    if (band.maxDistanceMetres === null) {
      samples.push((prevEdge < 0 ? 0 : prevEdge) + 100_000);
    } else {
      samples.push(band.maxDistanceMetres); // upper edge, inclusive
      prevEdge = band.maxDistanceMetres;
    }
  }
  return samples;
}

describe('estimateLegFare - distance-band boundaries (derived from opalFares.json)', () => {
  const railModes: TransportMode[] = ['train', 'metro', 'lightRail'];

  it('rail modes (train/metro/lightRail) map every boundary sample to the rail table fare', () => {
    for (const distance of boundarySamples('rail')) {
      const expected = expectedFareCents('rail', distance);
      for (const mode of railModes) {
        const fare = estimateLegFare(distance, mode);
        expect(fare, `${mode} @ ${distance}m`).not.toBeNull();
        expect(fare!.currency).toBe('AUD');
        expect(fare!.amountCents, `${mode} @ ${distance}m`).toBe(expected);
      }
    }
  });

  it('bus maps every boundary sample to the bus table fare', () => {
    for (const distance of boundarySamples('bus')) {
      const expected = expectedFareCents('bus', distance);
      const fare = estimateLegFare(distance, 'bus');
      expect(fare, `bus @ ${distance}m`).not.toBeNull();
      expect(fare!.amountCents, `bus @ ${distance}m`).toBe(expected);
    }
  });

  it('ferry maps every boundary sample to the ferry table fare', () => {
    for (const distance of boundarySamples('ferry')) {
      const expected = expectedFareCents('ferry', distance);
      const fare = estimateLegFare(distance, 'ferry');
      expect(fare, `ferry @ ${distance}m`).not.toBeNull();
      expect(fare!.amountCents, `ferry @ ${distance}m`).toBe(expected);
    }
  });

  it('train, metro, and lightRail return identical fares for the same distance', () => {
    for (const distance of [0, 10_000, 10_001, 20_000, 35_000, 65_001, 250_000]) {
      const train = estimateLegFare(distance, 'train');
      const metro = estimateLegFare(distance, 'metro');
      const lightRail = estimateLegFare(distance, 'lightRail');
      expect(metro).toEqual(train);
      expect(lightRail).toEqual(train);
    }
  });
});

describe('estimateLegFare - explicit literal band values (mirror opalFares.json seed)', () => {
  // These literals mirror the current seeded values in opalFares.json. They are
  // intentionally hard-pinned to catch accidental drift in the published seed.
  it('rail bands: 0/10000→420, 10001/20000→522, 20001/35000→601, 35001/65000→803, 65001+→1032', () => {
    expect(estimateLegFare(0, 'train')!.amountCents).toBe(420);
    expect(estimateLegFare(10_000, 'train')!.amountCents).toBe(420);
    expect(estimateLegFare(10_001, 'train')!.amountCents).toBe(522);
    expect(estimateLegFare(20_000, 'train')!.amountCents).toBe(522);
    expect(estimateLegFare(20_001, 'train')!.amountCents).toBe(601);
    expect(estimateLegFare(35_000, 'train')!.amountCents).toBe(601);
    expect(estimateLegFare(35_001, 'train')!.amountCents).toBe(803);
    expect(estimateLegFare(65_000, 'train')!.amountCents).toBe(803);
    expect(estimateLegFare(65_001, 'train')!.amountCents).toBe(1032);
  });

  it('bus bands: 0/3000→320, 3001/8000→379, 8001+→487', () => {
    expect(estimateLegFare(0, 'bus')!.amountCents).toBe(320);
    expect(estimateLegFare(3_000, 'bus')!.amountCents).toBe(320);
    expect(estimateLegFare(3_001, 'bus')!.amountCents).toBe(379);
    expect(estimateLegFare(8_000, 'bus')!.amountCents).toBe(379);
    expect(estimateLegFare(8_001, 'bus')!.amountCents).toBe(487);
  });

  it('ferry bands: 0/9000→643, 9001+→804', () => {
    expect(estimateLegFare(0, 'ferry')!.amountCents).toBe(643);
    expect(estimateLegFare(9_000, 'ferry')!.amountCents).toBe(643);
    expect(estimateLegFare(9_001, 'ferry')!.amountCents).toBe(804);
  });
});

describe('estimateLegFare - unpriceable inputs return null', () => {
  it('walk and bicycle connector legs are never priced', () => {
    for (const distance of [0, 5_000, 50_000]) {
      expect(estimateLegFare(distance, 'walk')).toBeNull();
      expect(estimateLegFare(distance, 'bicycle')).toBeNull();
    }
  });

  it('negative and non-finite distances return null', () => {
    expect(estimateLegFare(-1, 'train')).toBeNull();
    expect(estimateLegFare(-10_000, 'bus')).toBeNull();
    expect(estimateLegFare(Number.NaN, 'train')).toBeNull();
    expect(estimateLegFare(Number.POSITIVE_INFINITY, 'ferry')).toBeNull();
    expect(estimateLegFare(Number.NEGATIVE_INFINITY, 'bus')).toBeNull();
  });

  it('modes with no configured fare table (coach/school/other) are unpriceable', () => {
    const unmapped: TransportMode[] = ['coach', 'school', 'other'];
    for (const mode of unmapped) {
      expect(seed.modeToTable[mode]).toBeUndefined();
      expect(estimateLegFare(10_000, mode)).toBeNull();
    }
  });
});
