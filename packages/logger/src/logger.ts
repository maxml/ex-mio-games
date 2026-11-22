import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import { isErrorLike, sanitizeLogObject, scrubString } from './redact';

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

// Redaction is an ALLOW-list (§3.1: "No secrets/PII in logs"): see ./redact. Only known keys keep
// their value; every other key is censored, and the strings that pass are scrubbed.

/** Scrub the message arguments (pino's `hooks.logMethod`): `msg` never goes through formatters. */
function scrubLogArgs(args: unknown[]): unknown[] {
  const first = args[0];
  if (isErrorLike(first)) {
    return [{ err: first }, scrubString(first.message), ...args.slice(1).map(scrubArg)];
  }
  // pino falls back to `err.message` as the line's msg when none is given: that copy would skip
  // the scrub, so make the message explicit here.
  const err = (first as { err?: unknown } | undefined)?.err;
  if (
    typeof first === 'object' &&
    first !== null &&
    isErrorLike(err) &&
    typeof args[1] !== 'string'
  ) {
    return [first, scrubString(err.message), ...args.slice(1)];
  }
  return args.map(scrubArg);
}

function scrubArg(arg: unknown): unknown {
  return typeof arg === 'string' ? scrubString(arg) : arg;
}

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
      // `child({...})` bindings never pass through `log`; the same allow-list applies to them.
      bindings: (bindings) => sanitizeLogObject(bindings),
      // The allow-list choke point: every key of every line passes through here.
      log: sanitizeLogObject,
    },
    base,
    // Per-line trace correlation (§3.1, §5): stamps `trace_id`/`span_id` when an
    // OpenTelemetry span is active. Runs on every record, so it stays cheap and
    // never throws; a no-op when tracing is off (there is no active span).
    mixin: traceContextMixin,
    // The `err` shape is built (and scrubbed) in sanitizeLogObject; pino's default err serializer
    // would run again on it and rewrite `type` from the plain object's constructor.
    serializers: { err: (e: unknown) => e },
    hooks: {
      logMethod(args, method) {
        (method as (...a: unknown[]) => void).apply(this, scrubLogArgs(args as unknown[]));
      },
    },
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
  const root = destination ? pino(opts, destination) : pino(opts);
  // pino resets `formatters.bindings` to the identity for every child, so a child's bindings would
  // be written raw (D-31 R3). `child` is wrapped here: the bindings pass the allow-list first. The
  // wrapper is inherited by every child, and it calls pino's own `child` on `this`, so chains keep
  // their bindings.
  const pinoChild = root.child as (this: pino.Logger, b: pino.Bindings, o?: object) => pino.Logger;
  root.child = function child(this: pino.Logger, bindings: pino.Bindings, childOptions?: object) {
    return pinoChild.call(this, sanitizeLogObject(bindings), childOptions);
  } as typeof root.child;
  return root;
}

/**
 * Process-wide default logger. Its `service`/`env`/`version`/level come from the
 * environment (`SERVICE_NAME`/`NODE_ENV`/`APP_VERSION`/`LOG_LEVEL`); call
 * {@link createLogger} with a `name` to declare the service explicitly.
 */
export const logger = createLogger();

export default logger;
