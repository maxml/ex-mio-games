// Public API for the `shared/types` segment.
//
// The web app consumes the shared Zod schemas / inferred types through this
// FSD segment rather than importing `@ex-mio/contracts` directly,
// so the dependency on the shared package has a single, swappable entry point
// (ADR-0001 §3.1, §7: `types/ ← @ex-mio/contracts`).
export * from '@ex-mio/contracts';
