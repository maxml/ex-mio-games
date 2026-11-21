import { trace, type Span } from '@opentelemetry/api';
import { LogLevel, LogLine } from '@ex-mio/contracts';
import { createLogger } from './index';

// A minimal pino destination sink: pino calls `write(line)` synchronously with
// one `\n`-terminated JSON string per log call, so the captured lines are ready
// to parse immediately after the log call returns.
function captureLogger(options: Parameters<typeof createLogger>[0] = {}) {
  const raw: string[] = [];
  const sink = {
    write(chunk: string): void {
      raw.push(chunk);
    },
  };
  const logger = createLogger({ level: 'trace', ...options }, sink);
  return {
    logger,
    // Parse the emitted lines as JSON objects (dropping the trailing newline).
    lines(): Array<Record<string, unknown>> {
      return raw
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

describe('@ex-mio/logger', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    // Isolate the identity env vars so defaults are deterministic per test.
    process.env = { ...OLD_ENV };
    delete process.env.SERVICE_NAME;
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('emits a line that PARSES against the contracts LogLine schema (§3.1)', () => {
    const { logger, lines } = captureLogger({ name: 'ex-mio-api' });

    logger.info('request completed');

    const emitted = lines();
    expect(emitted).toHaveLength(1);

    // The key quality loop: the logger's output must satisfy the wire contract.
    const parsed = LogLine.parse(emitted[0]);

    // The required §3.1 fields are all present and well-typed.
    expect(parsed.service).toBe('ex-mio-api');
    expect(parsed.env).toBe('test');
    expect(typeof parsed.version).toBe('string');
    expect(parsed.version.length).toBeGreaterThan(0);
    expect(parsed.msg).toBe('request completed');
    // `ts` is ISO-8601 UTC (LogLine.parse enforces `.datetime()` already).
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
    // `level` is the LABEL and a member of the fixed LogLevel enum.
    expect(parsed.level).toBe('info');
    expect(LogLevel.options).toContain(parsed.level);
  });

  it('passes optional trace_id / span_id / http fields through unchanged (§3.1)', () => {
    const { logger, lines } = captureLogger({ name: 'ex-mio-api' });

    logger.info(
      {
        trace_id: '0af7651916cd43dd8448eb211c80319c',
        span_id: 'b7ad6b7169203331',
        http: { method: 'GET', route: '/users/:id', status: 200, duration_ms: 12 },
      },
      'request completed',
    );

    const parsed = LogLine.parse(lines()[0]);
    expect(parsed.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(parsed.span_id).toBe('b7ad6b7169203331');
    expect(parsed.http).toEqual({
      method: 'GET',
      route: '/users/:id',
      status: 200,
      duration_ms: 12,
    });
  });

  it('serializes errors into the LogLine `err` shape (§3.1)', () => {
    const { logger, lines } = captureLogger();

    logger.error({ err: new Error('boom') }, 'boom happened');

    const parsed = LogLine.parse(lines()[0]);
    expect(parsed.level).toBe('error');
    expect(parsed.err?.type).toBe('Error');
    expect(parsed.err?.message).toBe('boom');
    expect(typeof parsed.err?.stack).toBe('string');
  });

  it('emits the level label for every LogLevel enum member', () => {
    const { logger, lines } = captureLogger();

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    const levels = lines().map((line) => LogLine.parse(line).level);
    expect(levels).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
    for (const level of levels) {
      expect(LogLevel.options).toContain(level);
    }
  });

  it('redacts common secret keys at the top level and one level deep', () => {
    const { logger, lines } = captureLogger();

    logger.warn(
      {
        authorization: 'Bearer top-secret',
        password: 'hunter2',
        token: 'abc',
        cookie: 'sid=1',
        headers: { authorization: 'Bearer nested-secret', 'set-cookie': 'sid=2' },
      },
      'sensitive',
    );

    const line = lines()[0];
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('nested-secret');
    expect(serialized).not.toContain('hunter2');
    expect(line.authorization).toBe('[redacted]');
    expect(line.password).toBe('[redacted]');
    expect((line.headers as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((line.headers as Record<string, unknown>)['set-cookie']).toBe('[redacted]');
  });

  it('resolves service/env/version identity from the environment (§6)', () => {
    process.env.SERVICE_NAME = 'from-env-service';
    process.env.NODE_ENV = 'production';
    process.env.APP_VERSION = '1.4.2+ab12cd';

    const { logger, lines } = captureLogger();
    logger.info('identity');

    const parsed = LogLine.parse(lines()[0]);
    expect(parsed.service).toBe('from-env-service');
    expect(parsed.env).toBe('production');
    expect(parsed.version).toBe('1.4.2+ab12cd');
  });

  it('lets an explicit name option win over SERVICE_NAME', () => {
    process.env.SERVICE_NAME = 'from-env-service';

    const { logger, lines } = captureLogger({ name: 'explicit-service' });
    logger.info('identity');

    expect(LogLine.parse(lines()[0]).service).toBe('explicit-service');
  });
});

// The log↔trace link (§3.1, §5): the pino `mixin` stamps trace_id/span_id from
// the active OpenTelemetry span when tracing is on, and adds nothing when it is
// off. Driven by spying on `trace.getActiveSpan` so the guard logic is exercised
// without standing up an SDK / exporter (no network, no extra deps).
describe('@ex-mio/logger trace correlation (§3.1, §5)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function fakeSpan(traceId: string, spanId: string): Span {
    return { spanContext: () => ({ traceId, spanId, traceFlags: 1 }) } as unknown as Span;
  }

  it('omits trace_id/span_id when no span is active (tracing off)', () => {
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);

    const { logger, lines } = captureLogger({ name: 'ex-mio-api' });
    logger.info('outside any span');

    const parsed = LogLine.parse(lines()[0]);
    expect(parsed.trace_id).toBeUndefined();
    expect(parsed.span_id).toBeUndefined();
  });

  it('stamps trace_id/span_id from the active span', () => {
    jest
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(fakeSpan('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331'));

    const { logger, lines } = captureLogger({ name: 'ex-mio-api' });
    logger.info('within a span');

    const parsed = LogLine.parse(lines()[0]);
    expect(parsed.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(parsed.span_id).toBe('b7ad6b7169203331');
  });

  it('omits ids for a non-recording / invalid span context (all-zero ids)', () => {
    jest
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(fakeSpan('00000000000000000000000000000000', '0000000000000000'));

    const { logger, lines } = captureLogger({ name: 'ex-mio-api' });
    logger.info('invalid context');

    const parsed = LogLine.parse(lines()[0]);
    expect(parsed.trace_id).toBeUndefined();
    expect(parsed.span_id).toBeUndefined();
  });
});
