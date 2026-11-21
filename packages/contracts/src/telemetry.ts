import { z } from 'zod';

// Varta telemetry contract shapes (see api/TELEMETRY_CONTRACT.md).
// These schemas describe the wire shapes a project emits so Varta can watch it;
// the project never depends on Varta at runtime — it just conforms to these.

// §3.1 — the fixed log-level enum. MUST be closed so Varta can alert on
// `error`/`fatal` rates.
export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevel>;

// §3.1 — one structured JSON log line (one object per line, to stdout/stderr).
export const LogLine = z.object({
  ts: z.string().datetime(), // ISO-8601 UTC
  level: LogLevel,
  service: z.string(), // = service.name (§6)
  env: z.string(), // = deployment.environment (§6)
  version: z.string(), // = release (§6)
  msg: z.string(),
  // When tracing is on, these link a log line to its trace and back (§3.1).
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  // Present on request-scoped lines.
  http: z
    .object({
      method: z.string(),
      route: z.string(),
      status: z.number().int(),
      duration_ms: z.number(),
    })
    .optional(),
  // Present only on error lines.
  err: z
    .object({
      type: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    })
    .optional(),
});
export type LogLine = z.infer<typeof LogLine>;

// A product analytics event, written to stdout as one JSON line with
// `kind: "product_event"` so the log collector can route it apart from ordinary
// log lines. `event` is a stable snake_case name; `tenant_id` is mandatory.
export const ProductEventLine = z.object({
  kind: z.literal('product_event'),
  event: z.string().regex(/^[a-z][a-z0-9_]*$/),
  tenant_id: z.string().uuid(),
  player_id: z.string().uuid().optional(),
  properties: z.record(z.unknown()).optional(),
});
export type ProductEventLine = z.infer<typeof ProductEventLine>;

// §2.1 — the `varta_build_info{service,version,git_sha,env} 1` gauge label set.
// A low-cardinality label set whose values carry the release identity (the
// standard "build_info" pattern). `git_sha`, not the mutable version tag, is the
// deploy-correlation key (§6).
export const BuildInfo = z.object({
  service: z.string(),
  version: z.string(),
  git_sha: z.string(),
  env: z.string(),
});
export type BuildInfo = z.infer<typeof BuildInfo>;
