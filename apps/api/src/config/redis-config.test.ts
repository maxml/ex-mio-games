import { loadConfig } from './index';

const baseEnv = {
  DATABASE_URL: 'postgresql://starter:starter@localhost:5432/test',
} as NodeJS.ProcessEnv;

describe('loadConfig REDIS_URL', () => {
  it('treats REDIS_URL as optional (boots without Redis)', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.REDIS_URL).toBeUndefined();
  });

  it('accepts a plain REDIS_URL outside production', () => {
    const cfg = loadConfig({ ...baseEnv, REDIS_URL: 'redis://localhost:6379' });
    expect(cfg.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('rejects a non-TLS REDIS_URL in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
        REDIS_URL: 'redis://cache.example.com:6379',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TLS/);
  });

  it('accepts a rediss:// REDIS_URL in production', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
      REDIS_URL: 'rediss://cache.example.com:6379',
      STORAGE_LOCAL_ROOT: '/var/lib/app/uploads',
    } as NodeJS.ProcessEnv);
    expect(cfg.REDIS_URL).toBe('rediss://cache.example.com:6379');
  });

  it('accepts a tls=true REDIS_URL in production', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
      REDIS_URL: 'redis://cache.example.com:6379?tls=true',
      STORAGE_LOCAL_ROOT: '/var/lib/app/uploads',
    } as NodeJS.ProcessEnv);
    expect(cfg.REDIS_URL).toContain('tls=true');
  });

  it('skips the Redis guard in production when REDIS_URL is unset', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app?sslmode=require',
      STORAGE_LOCAL_ROOT: '/var/lib/app/uploads',
    } as NodeJS.ProcessEnv);
    expect(cfg.REDIS_URL).toBeUndefined();
  });
});
