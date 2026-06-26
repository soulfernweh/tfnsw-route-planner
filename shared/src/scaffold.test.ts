import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

// Scaffold smoke test (task 1.1): confirms Vitest runs across the workspace and
// that fast-check is available for the property-based tests added in later tasks.
// This file should be removed or replaced once real tests land.
describe('workspace tooling scaffold', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });

  it('runs fast-check property checks', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });
});
