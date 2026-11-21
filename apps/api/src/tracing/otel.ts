import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { buildInfoFromEnv, otlpExporterHeaders, otlpSignalUrl } from '../telemetry/otlp';

/**
 * The opt-in OTLP-push tracing bootstrap — Varta telemetry contract §5
 * (`api/TELEMETRY_CONTRACT.md`).
 *
 * Instruments incoming HTTP and NestJS handlers and exports spans over OTLP/HTTP
 * to the same host collector the metrics push targets (§2/§5), with the same
 * bearer scheme (the transport helpers in `../telemetry/otlp` are shared). It:
 *
 * - builds a `TracerProvider` with the §6 resource identity (one identity, every
 *   signal — the same `buildInfoFromEnv` the metrics + logger use),
 * - samples parent-based off a `TraceIdRatioBasedSampler` (§5, §8: don't export
 *   100% in prod) whose ratio comes from `OTEL_TRACES_SAMPLER_ARG`,
 * - propagates W3C `traceparent` (§5) so `trace_id` links logs (§3.1) and
 *   crashes (§4), and installs an AsyncLocalStorage context manager so the
 *   active span survives async request handling — which is what lets the logger
 *   trace mixin (`@ex-mio/logger`) stamp `trace_id`/`span_id` per line.
 *
 * **Opt-in / additive.** It starts ONLY when `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set (and `OTEL_TRACES_ENABLED` has not turned it off); otherwise it is a no-op
 * returning `null` — the guarantee that a project with no Varta env vars runs
 * exactly as today (no exporter, no patched libraries, no runtime dependency on
 * Varta). It must run BEFORE the instrumented libraries are imported, so the
 * bootstrap entry loads `./register` (which calls this) as its very first
 * import; see `register.ts`.
 */

/** Default sampling ratio in production (§5: 10–20% in prod). Non-prod defaults
 * to 1.0 — full traces are cheap and useful while developing. */
const DEFAULT_PROD_SAMPLE_RATIO = 0.1;

export interface TracingProviderHandle {
  tracerProvider: TracerProvider;
  /** Flush and stop the exporter — call on shutdown so buffered spans are sent. */
  shutdown: () => Promise<void>;
}

export function startTracing(env: NodeJS.ProcessEnv = process.env): TracingProviderHandle | null {
  // Opt-OUT: a dedicated toggle to disable traces while leaving metrics on, for a
  // host that pushes metrics but does not (yet) want span volume.
  const toggle = env.OTEL_TRACES_ENABLED?.trim().toLowerCase();
  if (toggle === 'false' || toggle === '0' || toggle === 'off' || toggle === 'no') {
    return null;
  }

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    return null;
  }

  try {
    const info = buildInfoFromEnv(env);

    // §6 — one identity, every signal. Mirrors the metrics resource
    // (`metrics/metrics.ts`): the stable semantic-convention keys for
    // name/version, and the contract's literal `deployment.environment` /
    // `git.sha` keys.
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: info.service,
      [ATTR_SERVICE_VERSION]: info.version,
      'deployment.environment': info.env,
      'git.sha': info.git_sha,
    });

    const exporter = new OTLPTraceExporter({
      url: otlpSignalUrl(endpoint, '/v1/traces'),
      headers: otlpExporterHeaders(env),
    });

    const sampler = new ParentBasedSampler({
      // Honor an upstream (propagated) sampling decision; for a root span, sample
      // at the configured ratio.
      root: new TraceIdRatioBasedSampler(samplingRatio(env)),
    });

    const tracerProvider = new TracerProvider({
      resource,
      sampler,
      spanProcessors: [new BatchSpanProcessor({ exporter })],
    });

    // Register globally BEFORE the app builds. The AsyncLocalStorage context
    // manager is what carries the active span across the request's async
    // boundaries, so `trace.getActiveSpan()` (used by the logger mixin and by
    // any child span) resolves to the in-flight request's span.
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    // W3C `traceparent` in/out (§5), so a trace spans web -> api -> downstream.
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(tracerProvider);

    // Auto-instrument the request path for this stack: incoming HTTP and Nest
    // controllers/handlers. Prisma uses its own query engine (not node `pg`), so
    // it is omitted; the resource/propagation above let more be turned on later
    // without re-instrumenting (§5).
    const unregisterInstrumentations = registerInstrumentations({
      tracerProvider,
      instrumentations: [new HttpInstrumentation(), new NestInstrumentation()],
    });

    return {
      tracerProvider,
      shutdown: async () => {
        unregisterInstrumentations();
        await tracerProvider.shutdown();
        contextManager.disable();
      },
    };
  } catch (err) {
    // Tracing is additive and non-invasive: a misconfigured exporter or a
    // patching failure must never stop the API from serving. Log and carry on
    // untraced (the OTel API globals stay at their no-op defaults).
    // eslint-disable-next-line no-console
    console.warn(
      'tracing: failed to start OTLP tracing; continuing without tracing',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * The sampling ratio (§5, §8). `OTEL_TRACES_SAMPLER_ARG` (the standard OTel env)
 * overrides; otherwise 10% in production and 100% elsewhere. Out-of-range or
 * unparseable values fall back to the default rather than sampling nothing.
 */
function samplingRatio(env: NodeJS.ProcessEnv): number {
  const fallback = env.NODE_ENV === 'production' ? DEFAULT_PROD_SAMPLE_RATIO : 1;
  const raw = env.OTEL_TRACES_SAMPLER_ARG?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
