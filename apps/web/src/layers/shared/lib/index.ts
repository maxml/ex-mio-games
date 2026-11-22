// Public API for the `shared/lib` segment — domain-agnostic helpers/utilities
// reused across layers (ADR-0013 §7). Hosts the Zustand UI store (client/UI state,
// ADR-0013 §4.2), the realtime connection store (ADR-0014 §7), and the `cn`
// class-name helper.
export * from './ui-store';
export * from './connection-store';
export { cn } from '@ex-mio/ui';
export { expectedPayout, rulesValid, sameWeights, spinsForDeposit, weightsValid } from './rules';
