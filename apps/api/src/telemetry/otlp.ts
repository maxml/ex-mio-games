import type { BuildInfo } from '@ex-mio/shared-types';

/**
 * Shared OTLP/HTTP transport helpers — Varta telemetry contract §2 (metrics) and
 * §5 (traces) (`api/TELEMETRY_CONTRACT.md`).
 *
 * Metrics (`metrics/metrics.ts`) and traces (`tracing/otel.ts`) push to the same
 * host collector with the same auth scheme (§2: bearer token on the OTLP
 * receiver); only the signal-specific path differs (`/v1/metrics` vs
 * `/v1/traces`), and both stamp the same §6 resource identity. These helpers are
 * that common ground, so the URL/header/identity handling lives in exactly one
 * place and the two signals cannot drift.
 *
 * Deliberately dependency-light (env + string work, and a type-only import that
 * erases at runtime): `tracing/` pulls this in on the bootstrap preload path,
 * ahead of the instrumented libraries, so it must not drag anything heavy (no
 * Nest, no Fastify, no `http`) into that path.
 */

/** Default `service.name` when `SERVICE_NAME` is not injected (§6). */
const DEFAULT_SERVICE_NAME = 'ex-mio-api';

/**
 * The §6 release identity, one identity for every signal, read from the env the
 * deploy plane injects (`SERVICE_NAME`/`APP_VERSION`/`GIT_SHA`/`NODE_ENV`).
 * `version` mirrors the /healthz + logger fallback chain; `git_sha` — the
 * immutable commit id, the correlation key (§6) — falls back to a placeholder
 * when unset (dev) since a metric label / resource attribute cannot be absent.
 */
export function buildInfoFromEnv(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    service: env.SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
    version: env.APP_VERSION ?? env.npm_package_version ?? '0.0.1',
    git_sha: env.GIT_SHA?.trim() || 'unknown',
    env: env.NODE_ENV ?? 'development',
  };
}

/**
 * The signal-specific OTLP/HTTP URL. `OTEL_EXPORTER_OTLP_ENDPOINT` is the
 * collector **base**; the receiver's per-signal endpoint is `<base><signalPath>`
 * (e.g. `<base>/v1/traces`). Tolerates a base that already carries the path or a
 * trailing slash, so setting either the base or the full signal URL both work.
 *
 * @param endpoint   the configured base (or full signal) endpoint
 * @param signalPath the signal suffix, e.g. `/v1/traces` or `/v1/metrics`
 */
export function otlpSignalUrl(endpoint: string, signalPath: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith(signalPath) ? base : `${base}${signalPath}`;
}

/**
 * Auth + any extra headers for the authenticated OTLP receiver (§2). An explicit
 * `OTEL_EXPORTER_OTLP_HEADERS` list (`k=v,k2=v2`) is parsed and wins; otherwise a
 * bearer `Authorization` header is built from the per-host `OTEL_INGEST_TOKEN`,
 * unless the headers env already set one.
 */
export function otlpExporterHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};

  const raw = env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (raw) {
    for (const pair of raw.split(',')) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key) {
          headers[key] = value;
        }
      }
    }
  }

  const token = env.OTEL_INGEST_TOKEN?.trim();
  if (token && !('Authorization' in headers) && !('authorization' in headers)) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}
