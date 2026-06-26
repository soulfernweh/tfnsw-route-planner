import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Transform JSX/TSX in test files using the automatic React runtime so
  // component tests do not need an explicit React import. Only affects
  // JSX/TSX files; plain .ts node tests are unaffected.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Run tests from every workspace package. Frontend component tests use the
    // .test.tsx suffix; backend/shared logic tests use .test.ts.
    include: ['{shared,backend,frontend}/src/**/*.test.{ts,tsx}'],
    // Default to the Node environment for backend/shared tests. Frontend
    // component tests opt into jsdom per-file via a
    // `// @vitest-environment jsdom` docblock.
    environment: 'node',
    globals: true,
    // Property-based tests run >= 100 iterations, so allow generous timeouts.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
});
