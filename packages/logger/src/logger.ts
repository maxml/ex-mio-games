import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';

/**
 * The logger instance type. Re-exported so consumers can type a logger slot
 * (e.g. a framework's logger option) without importing `pino` directly.
 */
export type AppLogger = pino.Logger;

// A pino-based structured logger that emits the Varta telemetry §3.1 log-line
// shape — one JSON object per line to stdout — so Varta's collector can tail it
// (see api/TELEMETRY_CONTRACT.md §3). The project never depends on Varta at
// runtime; it just conforms to the wire shape. The emitted keys are:
//   ts       ISO-8601 UTC timestamp
//   level    the pino level LABEL (trace|debug|info|warn|error|fatal) — matches
//            the contracts LogLevel enum, not a numeric level
//   service  = service.name (§6)
//   env      = deployment.environment (§6)
//   version  = release (§6)
//   msg      the log message
// A `mixin` auto-stamps trace_id / span_id from the active OpenTelemetry span
// when tracing is on (§5); http / err are passed through when provided.

/**
 * Options for {@link createLogger}. All optional: the identity fields default
 * from the environment so a deployed service needs no code change (the deploy
 * plane injects `APP_VERSION`/`NODE_ENV`; see §6 labeling).
 */
export interface LoggerOptions {
  /**
   * Service name (= OTel `service.name`, §6) — becomes the `service` field on
   * every line. Falls back to `SERVICE_NAME`, then a neutral default.
   */
  name?: string;
  /** Minimum level to emit. Defaults to the `LOG_LEVEL` env var, then `info`. */
  level?: pino.LevelWithSilent;
  /**
   * Extra pino options merged last — an escape hatch for advanced callers.
   * Anything set here overrides the contract defaults, so use with care.
   */
  pino?: pino.LoggerOptions;
}

// Secret-bearing keys scrubbed from every line (§3.1: "No secrets/PII in logs").
// Covered at the top level and one level deep (e.g. a `headers`/`req.headers`
// bag): hyphenated keys use fast-redact bracket notation, and the `*.<key>`
// forms catch the same secret nested one level under any parent.
const REDACT_PATHS = [
  'authorization',
  'password',
  'token',
  'cookie',
  '["set-cookie"]',
  '*.authorization',
  '*.password',
  '*.token',
  '*.cookie',
  '*["set-cookie"]',
];

const REDACT_CENSOR = '[redacted]';

function resolveService(name?: string): string {
  return name ?? process.env.SERVICE_NAME ?? 'app';
}

function resolveEnv(): string {
  return process.env.NODE_ENV ?? 'development';
}

function resolveVersion(): string {
  // Mirror the /healthz version fallback (see service-kit health):
  // the deploy plane injects APP_VERSION (§6); fall back so `version` is always
  // a non-empty string, which the LogLine schema requires.
  return process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.1';
}

/**
 * Build the pino options that emit the §3.1 shape. Exposed for callers that want
 * to construct a pino instance themselves (e.g. hand it to a framework's logger
 * slot) while keeping the exact same contract-conforming configuration.
 */
export function buildLoggerOptions(options: LoggerOptions = {}): pino.LoggerOptions {
  // service/env/version ride on every line via `base`, resolved once here. Using
  // `base` (not `mixin`) replaces pino's default pid/hostname pair — neither of
  // which is part of the contract shape — with the three identity fields.
  const base = {
    service: resolveService(options.name),
    env: resolveEnv(),
    version: resolveVersion(),
  };

  return {
    level: options.level ?? (process.env.LOG_LEVEL as pino.LevelWithSilent | undefined) ?? 'info',
    // The message lands under `msg` (§3.1). This is pino's default too, but set
    // explicitly so the contract key is pinned regardless of pino's defaults.
    messageKey: 'msg',
    // Emit `,"ts":"<ISO-8601 UTC>"` in place of pino's default epoch `time`.
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    // Emit the level LABEL (`"info"`) rather than a number — the label set
    // trace|debug|info|warn|error|fatal already matches the LogLevel enum (§3.1).
    formatters: {
      level: (label) => ({ level: label }),
    },
    base,
    // Per-line trace correlation (§3.1, §5): stamps `trace_id`/`span_id` when an
    // OpenTelemetry span is active. Runs on every record, so it stays cheap and
    // never throws; a no-op when tracing is off (there is no active span).
    mixin: traceContextMixin,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    ...options.pino,
  };
}

/**
 * Pino `mixin` that links a log line to its trace (§3.1). When an OpenTelemetry
 * span is active it returns `{ trace_id, span_id }` from the span context;
 * otherwise `{}`, adding nothing. This reads only `@opentelemetry/api`, whose
 * global tracer is a no-op until the app's `tracing/` bootstrap starts it — so
 * when tracing is off there is never an active span and the log line is
 * unchanged. `isSpanContextValid` guards against a non-recording / invalid
 * context (all-zero ids), which would otherwise write meaningless `00000…` ids
 * that link to no real trace.
 */
function traceContextMixin(): { trace_id: string; span_id: string } | Record<string, never> {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) {
    return {};
  }
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

/**
 * Create a pino logger that emits the Varta telemetry §3.1 structured-log shape,
 * one JSON object per line. Writes to stdout by default; pass `destination` (any
 * object with a `write(msg)` method) to capture output — used by tests.
 */
export function createLogger(
  options: LoggerOptions = {},
  destination?: pino.DestinationStream,
): pino.Logger {
  const opts = buildLoggerOptions(options);
  return destination ? pino(opts, destination) : pino(opts);
}

/**
 * Process-wide default logger. Its `service`/`env`/`version`/level come from the
 * environment (`SERVICE_NAME`/`NODE_ENV`/`APP_VERSION`/`LOG_LEVEL`); call
 * {@link createLogger} with a `name` to declare the service explicitly.
 */
export const logger = createLogger();

export default logger;
