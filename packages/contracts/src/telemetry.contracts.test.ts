import { BuildInfo, LogLevel, LogLine } from './index';

describe('telemetry contracts', () => {
  it('exports the documented telemetry schemas from the barrel', () => {
    expect(LogLevel).toBeDefined();
    expect(LogLine).toBeDefined();
    expect(BuildInfo).toBeDefined();
  });

  it('accepts a well-formed LogLine (§3.1)', () => {
    const parsed = LogLine.parse({
      ts: '2026-08-09T10:11:12.345Z',
      level: 'info',
      service: 'ex-mio-api',
      env: 'production',
      version: '1.4.2+ab12cd',
      msg: 'request completed',
      trace_id: '0af7651916cd43dd8448eb211c80319c',
      span_id: 'b7ad6b7169203331',
      http: { method: 'GET', route: '/users/:id', status: 200, duration_ms: 12 },
    });

    expect(parsed).toMatchObject({
      level: 'info',
      service: 'ex-mio-api',
      http: { route: '/users/:id', status: 200 },
    });
  });

  it('accepts a minimal LogLine — optional http/err/trace fields omitted', () => {
    const parsed = LogLine.parse({
      ts: '2026-08-09T10:11:12.345Z',
      level: 'error',
      service: 'ex-mio-api',
      env: 'production',
      version: '1.4.2+ab12cd',
      msg: 'boom',
      err: { type: 'Error', message: 'boom' },
    });

    expect(parsed.http).toBeUndefined();
    expect(parsed.trace_id).toBeUndefined();
    expect(parsed.err).toMatchObject({ type: 'Error', message: 'boom' });
    // `stack` is optional on `err`.
    expect(parsed.err?.stack).toBeUndefined();
  });

  it('rejects a LogLine with a bad level enum value', () => {
    expect(
      LogLine.safeParse({
        ts: '2026-08-09T10:11:12.345Z',
        level: 'verbose', // not in the fixed enum
        service: 'ex-mio-api',
        env: 'production',
        version: '1.4.2+ab12cd',
        msg: 'nope',
      }).success,
    ).toBe(false);
  });

  it('rejects a LogLine missing a required field (msg)', () => {
    expect(
      LogLine.safeParse({
        ts: '2026-08-09T10:11:12.345Z',
        level: 'info',
        service: 'ex-mio-api',
        env: 'production',
        version: '1.4.2+ab12cd',
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed BuildInfo label set (§2.1)', () => {
    const parsed = BuildInfo.parse({
      service: 'ex-mio-api',
      version: '1.4.2',
      git_sha: 'ab12cd3',
      env: 'production',
    });

    expect(parsed).toMatchObject({
      service: 'ex-mio-api',
      git_sha: 'ab12cd3',
    });
  });

  it('rejects a BuildInfo missing a required label (git_sha)', () => {
    expect(
      BuildInfo.safeParse({
        service: 'ex-mio-api',
        version: '1.4.2',
        env: 'production',
      }).success,
    ).toBe(false);
  });
});
