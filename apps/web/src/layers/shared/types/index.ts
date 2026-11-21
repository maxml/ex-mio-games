// Public API for the `shared/types` segment.
//
// The web app consumes the shared Zod schemas / inferred types through this
// FSD segment rather than importing `@ex-mio/shared-types` directly,
// so the dependency on the shared package has a single, swappable entry point
// (ADR-0005 §3.1, §7: `types/ ← @ex-mio/shared-types`).
export * from '@ex-mio/shared-types';
