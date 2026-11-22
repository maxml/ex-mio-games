import {
  buildDataSourceOptions,
  loadEnv,
  BaseEnv,
  resolvePostgresSsl,
  resolvePostgresSslMode,
  stripSslMode,
} from './index';

const URL_ = 'postgresql://u:p@localhost:5432/db';

describe('postgres TLS mode', () => {
  it('is off by default outside production', () => {
    expect(resolvePostgresSslMode({ DATABASE_URL: URL_ })).toBe('disable');
    expect(resolvePostgresSsl({ DATABASE_URL: URL_ })).toBe(false);
  });

  it('must be stated explicitly in production', () => {
    expect(() => resolvePostgresSslMode({ NODE_ENV: 'production', DATABASE_URL: URL_ })).toThrow(
      /DATABASE_SSL is required/,
    );
  });

  it('production accepts an explicit disable for a database without TLS', () => {
    expect(
      resolvePostgresSslMode({
        NODE_ENV: 'production',
        DATABASE_URL: URL_,
        DATABASE_SSL: 'disable',
      }),
    ).toBe('disable');
  });

  it('require encrypts without verifying; verify-full verifies', () => {
    expect(resolvePostgresSsl({ DATABASE_URL: URL_, DATABASE_SSL: 'require' })).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolvePostgresSsl({ DATABASE_URL: URL_, DATABASE_SSL: 'verify-full' })).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('honours sslmode in the URL when DATABASE_SSL is unset', () => {
    expect(
      resolvePostgresSslMode({ NODE_ENV: 'production', DATABASE_URL: `${URL_}?sslmode=require` }),
    ).toBe('require');
  });

  it('rejects an unknown value', () => {
    expect(() => resolvePostgresSslMode({ DATABASE_URL: URL_, DATABASE_SSL: 'yes' })).toThrow();
  });

  it('strips sslmode from the URL handed to pg', () => {
    expect(stripSslMode(`${URL_}?sslmode=require`)).toBe(URL_);
  });
});

describe('data source options', () => {
  it('never synchronizes and never runs migrations on boot', () => {
    const o = buildDataSourceOptions({
      env: { DATABASE_URL: URL_, NODE_ENV: 'production', DATABASE_SSL: 'disable' },
      entities: [],
      migrations: [],
    });
    expect(o.synchronize).toBe(false);
    expect(o.migrationsRun).toBe(false);
  });
});

describe('loadEnv', () => {
  it('lists every problem', () => {
    expect(() => loadEnv(BaseEnv, {})).toThrow(/PORT[\s\S]*DATABASE_URL/);
  });
});
