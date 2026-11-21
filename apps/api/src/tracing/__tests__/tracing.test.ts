import { trace } from '@opentelemetry/api';
import { startTracing } from '../otel';

/**
 * The opt-in guarantee of TELEMETRY_CONTRACT §5 (`api/TELEMETRY_CONTRACT.md`):
 * with no Varta env vars, tracing does not start — no exporter, no patched
 * libraries, no swap of the global tracer provider. A project that sets nothing
 * runs exactly as today. No network is touched here (the started path is never
 * exercised).
 */
describe('startTracing (TELEMETRY_CONTRACT §5, opt-in)', () => {
  it('is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    const before = trace.getTracerProvider();

    const handle = startTracing({} as NodeJS.ProcessEnv);

    expect(handle).toBeNull();
    // Additive: the global tracer provider is untouched, so nothing was
    // registered and no span machinery is live.
    expect(trace.getTracerProvider()).toBe(before);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('treats a blank/whitespace endpoint as unset', () => {
    expect(startTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('stays off when OTEL_TRACES_ENABLED opts out, even with an endpoint set', () => {
    const before = trace.getTracerProvider();

    const handle = startTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4318',
      OTEL_TRACES_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);

    expect(handle).toBeNull();
    expect(trace.getTracerProvider()).toBe(before);
  });
});
