import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type DataPoint,
  type Histogram as HistogramValue,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { BuildInfo } from '@ex-mio/shared-types';
import { AppMetrics, createAppMetrics } from '../metrics';
import { buildServer } from '../../server';
import type { AppDatabase } from '../../db';
import type { AuthService } from '../../auth';
import type { StorageObject, StorageService } from '../../storage';

const fakeDatabase: AppDatabase = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  ping: jest.fn().mockResolvedValue('ok'),
  listUsers: jest.fn().mockResolvedValue([]),
  createUser: jest.fn(),
};
const fakeAuth = {
  verifyToken: jest.fn(),
} as unknown as AuthService;
const fileData = Buffer.from('hello');
const fakeStorage: StorageService = {
  put: jest.fn(),
  get: jest.fn().mockImplementation(
    async (key: string): Promise<StorageObject> => ({
      key,
      contentType: 'text/plain',
      size: fileData.byteLength,
      checksum: 'checksum',
      data: fileData,
    }),
  ),
  delete: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(true),
  getUrl: jest.fn().mockImplementation(async (key: string) => `/api/files/${key}`),
  health: jest.fn().mockResolvedValue({ status: 'ok', latencyMs: 1 }),
};

// Wait a macrotask so the response 'finish' listener (which records the metrics)
// runs before we flush the reader.
const tick = () => new Promise((resolve) => setImmediate(resolve));

function findMetric(exporter: InMemoryMetricExporter, name: string): MetricData {
  for (const resourceMetric of exporter.getMetrics()) {
    for (const scope of resourceMetric.scopeMetrics) {
      const match = scope.metrics.find((metric) => metric.descriptor.name === name);
      if (match) return match;
    }
  }
  throw new Error(`metric "${name}" was not exported`);
}

function points(metric: MetricData): DataPoint<unknown>[] {
  return metric.dataPoints as DataPoint<unknown>[];
}

function attr(point: DataPoint<unknown>, key: string): unknown {
  return (point.attributes as Record<string, unknown>)[key];
}

describe('AppMetrics (Varta telemetry §2)', () => {
  it('records http_server_* with a route TEMPLATE + status_code and exposes varta_build_info', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2 ** 31 - 1, // effectively never auto-fires; we force flush
    });
    const metrics = new AppMetrics({
      serviceName: 'ex-mio-api',
      version: '1.4.2',
      gitSha: 'ab12cd3',
      env: 'production',
      reader,
      collectHostMetrics: false, // keep the test hermetic (no systeminformation)
    });
    expect(metrics.enabled).toBe(true);

    const app = await buildServer({
      database: fakeDatabase,
      auth: fakeAuth,
      storage: fakeStorage,
      corsOrigin: '*',
      logLevel: 'silent',
      metrics,
    });

    try {
      // A concrete, id-bearing path; the metric label must be the template.
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/api/files/file_abc123',
      });
      expect(res.statusCode).toBe(200);

      await tick();
      await metrics.forceFlush();

      // http_server_requests_total — counter, one series for the handled request.
      const counter = findMetric(exporter, 'http_server_requests_total');
      const counterPoint = points(counter).find(
        (point) => attr(point, 'route') === '/api/files/:key',
      );
      expect(counterPoint).toBeDefined();
      expect(counterPoint?.value).toBe(1);
      expect(attr(counterPoint as DataPoint<unknown>, 'method')).toBe('GET');
      expect(attr(counterPoint as DataPoint<unknown>, 'status_code')).toBe('200');
      // §8: the raw path must NOT leak into the label set.
      expect(attr(counterPoint as DataPoint<unknown>, 'route')).not.toContain('file_abc123');

      // http_server_request_duration_seconds — histogram, same label set, recorded.
      const histogram = findMetric(exporter, 'http_server_request_duration_seconds');
      expect(histogram.descriptor.unit).toBe('s');
      const histPoint = points(histogram).find(
        (point) => attr(point, 'route') === '/api/files/:key',
      );
      expect(histPoint).toBeDefined();
      expect((histPoint?.value as HistogramValue).count).toBeGreaterThanOrEqual(1);
      expect(attr(histPoint as DataPoint<unknown>, 'status_code')).toBe('200');

      // varta_build_info — gauge = 1, whose labels carry the release identity and
      // MUST satisfy the shared BuildInfo contract schema (§2.1).
      const buildInfo = findMetric(exporter, 'varta_build_info');
      const buildPoint = points(buildInfo)[0];
      expect(buildPoint).toBeDefined();
      expect(buildPoint?.value).toBe(1);
      const labels = BuildInfo.parse(buildPoint?.attributes);
      expect(labels).toEqual({
        service: 'ex-mio-api',
        version: '1.4.2',
        git_sha: 'ab12cd3',
        env: 'production',
      });
    } finally {
      await app.close();
      await metrics.shutdown();
    }
  });

  it('is a disabled no-op when no OTLP endpoint is configured (opt-in)', () => {
    const disabled = createAppMetrics({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(disabled.enabled).toBe(false);
    // Recording into the no-op instruments must not throw.
    expect(() =>
      disabled.requestsTotal.add(1, { method: 'GET', route: '/x', status_code: '200' }),
    ).not.toThrow();
  });

  it('enables the exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set', async () => {
    const enabled = createAppMetrics({
      NODE_ENV: 'production',
      APP_VERSION: '2.0.0',
      GIT_SHA: 'deadbeef',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_INGEST_TOKEN: 'secret-token',
    } as NodeJS.ProcessEnv);
    try {
      expect(enabled.enabled).toBe(true);
      expect(enabled.buildInfoLabels).toEqual({
        service: 'ex-mio-api',
        version: '2.0.0',
        git_sha: 'deadbeef',
        env: 'production',
      });
    } finally {
      // Never call start()/export → no network; just tear down the reader timer.
      await enabled.shutdown();
    }
  });
});
