import { metrics as metricsApi, type Counter, type Histogram } from '@opentelemetry/api';
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { BuildInfo } from '@ex-mio/shared-types';
import { buildInfoFromEnv, otlpExporterHeaders, otlpSignalUrl } from '../telemetry/otlp';

// Varta telemetry §2 — app metrics over OTLP **push** (a `/metrics` scrape is
// unreachable under Deckhand's no-host-ports rule). This module owns an
// OpenTelemetry MeterProvider whose PeriodicExportingMetricReader pushes to the
// host collector's OTLP endpoint, plus the §2.1 instrument set. It is opt-in: when
// `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, `createAppMetrics()` builds a disabled
// (no-op) instance so the app runs exactly as today and binds nothing.

const METER_NAME = 'ex-mio-api';
const DURATION_METRIC = 'http_server_request_duration_seconds';

// §2.1 request-duration histogram boundaries, in SECONDS (the SDK default buckets
// are millisecond-scaled). Standard latency ladder from 5ms to 10s.
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface AppMetricsOptions {
  serviceName: string;
  version: string;
  gitSha: string;
  env: string;
  /**
   * The metric reader to export through. When omitted the instance is **disabled**
   * (a no-op meter, no exporter) — the interceptor becomes a pure passthrough.
   * Tests pass an in-memory reader here.
   */
  reader?: IMetricReader;
  /**
   * Collect default process/runtime metrics (CPU, RSS, ...) via host-metrics on
   * `start()`. Defaults to true when enabled; tests disable it to stay hermetic.
   */
  collectHostMetrics?: boolean;
}

/**
 * The OpenTelemetry metrics surface for the API: the §2.1 instrument set plus the
 * MeterProvider/reader that exports them. `enabled` is false when no OTLP endpoint
 * (reader) is configured, in which case every instrument is a no-op.
 */
export class AppMetrics {
  readonly enabled: boolean;
  readonly requestsTotal: Counter;
  readonly requestDuration: Histogram;
  readonly buildInfoLabels: BuildInfo;
  private readonly provider?: MeterProvider;
  private readonly collectHostMetrics: boolean;
  private hostMetrics?: HostMetrics;
  private started = false;

  constructor(options: AppMetricsOptions) {
    // Validate the build_info label set against the shared contract schema (§2.1).
    this.buildInfoLabels = BuildInfo.parse({
      service: options.serviceName,
      version: options.version,
      git_sha: options.gitSha,
      env: options.env,
    });
    this.collectHostMetrics = options.collectHostMetrics ?? true;
    this.enabled = options.reader !== undefined;

    let meter;
    if (options.reader) {
      this.provider = new MeterProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: options.serviceName,
          [ATTR_SERVICE_VERSION]: options.version,
          // deployment.environment(.name) + git.sha are not stable-semconv exports,
          // so use the literal attribute keys the contract §6 mandates.
          'deployment.environment': options.env,
          'git.sha': options.gitSha,
        }),
        readers: [options.reader],
        views: [
          {
            instrumentName: DURATION_METRIC,
            aggregation: {
              type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
              options: { boundaries: DURATION_BUCKETS_SECONDS },
            },
          },
        ],
      });
      meter = this.provider.getMeter(METER_NAME);
    } else {
      // Disabled: the global API no-op meter. Instruments still exist so the
      // interceptor can reference them, but nothing is recorded or exported.
      meter = metricsApi.getMeter(METER_NAME);
    }

    this.requestsTotal = meter.createCounter('http_server_requests_total', {
      description:
        'Total HTTP server requests handled, labeled by method/route/status_code (§2.1).',
    });
    this.requestDuration = meter.createHistogram(DURATION_METRIC, {
      description: 'HTTP server request duration in seconds, by method/route/status_code (§2.1).',
      unit: 's',
    });
    const buildInfo = meter.createObservableGauge('varta_build_info', {
      description: 'Always 1; the release identity is carried by its labels (§2.1 build_info).',
    });
    buildInfo.addCallback((result) => {
      result.observe(1, this.buildInfoLabels);
    });
  }

  /**
   * Start collecting default process/runtime metrics. Idempotent and a no-op when
   * disabled; the http instruments and build_info do not need it.
   */
  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    if (this.collectHostMetrics && this.provider) {
      // host-metrics' process instruments (CPU, RSS, ...) attach to our provider
      // and export over the same reader (§2.1 default process metrics).
      this.hostMetrics = new HostMetrics({ meterProvider: this.provider, name: METER_NAME });
      this.hostMetrics.start();
    }
  }

  /** Force the reader to collect and export now (used by tests). */
  async forceFlush(): Promise<void> {
    await this.provider?.forceFlush();
  }

  /** Flush buffered metrics and stop the reader's export timer. */
  async shutdown(): Promise<void> {
    await this.provider?.shutdown();
  }
}

/**
 * Build an {@link AppMetrics} from the environment. The exporter (and thus metric
 * recording) is wired **only** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise
 * a disabled no-op instance is returned so the app is unchanged (§2, opt-in).
 */
export function createAppMetrics(env: NodeJS.ProcessEnv = process.env): AppMetrics {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const reader = endpoint ? createOtlpReader(endpoint, env) : undefined;
  // §6 — one identity, every signal (the same helper the tracing resource uses).
  const info = buildInfoFromEnv(env);
  return new AppMetrics({
    serviceName: info.service,
    version: info.version,
    gitSha: info.git_sha,
    env: info.env,
    reader,
  });
}

function createOtlpReader(endpoint: string, env: NodeJS.ProcessEnv): IMetricReader {
  const exporter = new OTLPMetricExporter({
    // Shared OTLP transport helpers (§2/§5): same base endpoint + auth scheme as
    // traces, only the signal path differs.
    url: otlpSignalUrl(endpoint, '/v1/metrics'),
    headers: otlpExporterHeaders(env),
  });
  return new PeriodicExportingMetricReader({ exporter });
}
