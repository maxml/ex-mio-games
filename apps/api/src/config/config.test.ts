import { loadConfig } from './index';

const baseEnv = {
  DATABASE_URL: 'postgresql://starter:starter@localhost:5432/test',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(4000);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.CORS_ORIGIN).toBe('http://localhost:3000');
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig({ ...baseEnv, PORT: '5050' });
    expect(cfg.PORT).toBe(5050);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });

  it('requires database SSL/TLS in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'mongodb://localhost:27017/prod',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SSL\/TLS/);
  });

  it('accepts production MongoDB URLs with TLS enabled', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'mongodb://db.example.com:27017/prod?tls=true',
      STORAGE_LOCAL_ROOT: '/var/lib/app/uploads',
    } as NodeJS.ProcessEnv);

    expect(cfg.NODE_ENV).toBe('production');
  });

  it('accepts production PostgreSQL URLs with sslmode enabled', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
      STORAGE_LOCAL_ROOT: '/var/lib/app/uploads',
    } as NodeJS.ProcessEnv);

    expect(cfg.NODE_ENV).toBe('production');
  });

  it('rejects production PostgreSQL URLs with sslmode=disable', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=disable',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SSL\/TLS/);
  });

  it("rejects CORS_ORIGIN '*' in production (credentials are enabled)", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
        CORS_ORIGIN: '*',
      } as NodeJS.ProcessEnv),
    ).toThrow(/CORS_ORIGIN must not allow any origin/);
  });

  it("rejects a CORS_ORIGIN list that hides a '*' in production (trailing)", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
        CORS_ORIGIN: 'https://app.example.com,*',
      } as NodeJS.ProcessEnv),
    ).toThrow(/CORS_ORIGIN must not allow any origin/);
  });

  it("rejects a CORS_ORIGIN list that hides a '*' in production (leading, with spaces)", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
        CORS_ORIGIN: ' * , https://app.example.com ',
      } as NodeJS.ProcessEnv),
    ).toThrow(/CORS_ORIGIN must not allow any origin/);
  });

  it('accepts an explicit CORS_ORIGIN allow-list in production', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
      CORS_ORIGIN: 'https://app.example.com,https://admin.example.com',
      STORAGE_LOCAL_ROOT: '/var/lib/app/uploads',
    } as NodeJS.ProcessEnv);

    expect(cfg.CORS_ORIGIN).toBe('https://app.example.com,https://admin.example.com');
  });

  it("allows CORS_ORIGIN '*' outside production (dev-only convenience)", () => {
    const cfg = loadConfig({ ...baseEnv, CORS_ORIGIN: '*' });
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.CORS_ORIGIN).toBe('*');
  });
});
