// Public API for the `shared/lib` segment — domain-agnostic helpers/utilities
// reused across layers (ADR-0005 §7). Hosts the Zustand UI store (client/UI state,
// ADR-0005 §4.2), the realtime connection store (ADR-0003 §7), and the `cn`
// class-name helper.
export * from './ui-store';
export * from './connection-store';
export { cn } from './cn';
