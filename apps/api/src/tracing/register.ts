import 'dotenv/config';
import { startTracing, type TracingProviderHandle } from './otel';

/**
 * Bootstrap preload for opt-in OTLP tracing (Varta telemetry contract §5).
 * Importing this module starts tracing as a **side effect**, so it MUST be the
 * very first import in the entry point (`src/index.ts`) — ahead of
 * `reflect-metadata` / Nest / Fastify / `http` — so the instrumentations patch
 * those libraries before they are first required. It is a no-op unless the env
 * opts in (see `startTracing`), so a project with no Varta env vars is
 * unaffected.
 *
 * `dotenv/config` runs first so a developer who enables traces locally through
 * `.env` is honored on this early path; `src/config` loads dotenv again later,
 * which is a no-op — dotenv never overrides an already-set variable.
 *
 * The handle (or `null`) is exported so the entry can flush buffered spans on
 * shutdown.
 */
export const tracingHandle: TracingProviderHandle | null = startTracing();
