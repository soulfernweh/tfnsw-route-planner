// Public module surface for the @tfnsw/frontend package.
//
// The SPA itself is bootstrapped from `main.tsx` via `index.html` (Vite).
// This barrel re-exports the reusable, framework-agnostic pieces (the typed
// API client and contract types) so they can be imported by tests and future
// modules. UI components are added in later tasks
// (see .kiro/specs/tfnsw-route-planner/tasks.md, task 11).

export { ApiClient, ApiError, apiClient } from './api/client';
export type { ApiClientOptions, PlanRoutesParams } from './api/client';
export { getApiBaseUrl } from './api/config';
export type * from './api/types';
