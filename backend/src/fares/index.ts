// Public entry point for the Opal fare estimation module.
//
// Re-exports the Opal Fare Calculator so consumers (e.g. the EFA journey
// normaliser in task 5.4) can import from `../fares/index.js` without reaching
// into the implementation file directly.

export { estimateLegFare } from './opalFareCalculator.js';
