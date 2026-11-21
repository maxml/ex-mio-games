import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPublicRuntimeConfig,
  joinApiUrl,
  resolveApiBaseUrl,
  resolveWsBaseUrl,
  type PublicRuntimeConfig,
} from './runtime';

// Runtime config resolver. The web image must be domain-agnostic: the
// browser defaults to the same origin (`''`), while the server reads a runtime
// env. These tests exercise both execution contexts by stubbing `window`.
//
// The vitest env sets NEXT_PUBLIC_API_URL='http://localhost:4000' globally
// (vitest.config.ts), so tests that need it unset delete it and restore after.

type MutableGlobal = typeof globalThis & { __APP_CONFIG__?: Partial<PublicRuntimeConfig> };

function setEnv(key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

describe('resolveApiBaseUrl', () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
    vi.unstubAllGlobals();
    delete (globalThis as MutableGlobal).__APP_CONFIG__;
  });

  it('an explicit override always wins (client and server)', () => {
    expect(resolveApiBaseUrl('https://explicit.example')).toBe('https://explicit.example');
    vi.stubGlobal('window', undefined);
    expect(resolveApiBaseUrl('https://explicit.example')).toBe('https://explicit.example');
  });

  describe('on the client (window defined)', () => {
    it('uses the build-time NEXT_PUBLIC_API_URL when set', () => {
      restores.push(setEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000'));
      expect(resolveApiBaseUrl()).toBe('http://localhost:4000');
    });

    it('defaults to the SAME ORIGIN ("") when nothing is configured — domain-agnostic', () => {
      restores.push(setEnv('NEXT_PUBLIC_API_URL', undefined));
      expect(resolveApiBaseUrl()).toBe('');
    });

    it('honours a runtime-injected window.__APP_CONFIG__ over the build-time value', () => {
      restores.push(setEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000'));
      (globalThis as MutableGlobal).__APP_CONFIG__ = { apiUrl: 'https://runtime.example' };
      expect(resolveApiBaseUrl()).toBe('https://runtime.example');
    });
  });

  describe('on the server (window undefined)', () => {
    it('prefers the runtime API_URL over the build-time NEXT_PUBLIC_API_URL', () => {
      vi.stubGlobal('window', undefined);
      restores.push(setEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000'));
      restores.push(setEnv('API_URL', 'http://api:4000'));
      expect(resolveApiBaseUrl()).toBe('http://api:4000');
    });

    it('falls back to NEXT_PUBLIC_API_URL when API_URL is unset (dev SSR)', () => {
      vi.stubGlobal('window', undefined);
      restores.push(setEnv('API_URL', undefined));
      restores.push(setEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000'));
      expect(resolveApiBaseUrl()).toBe('http://localhost:4000');
    });

    it('returns "" when neither is set (caller treats it as unreachable)', () => {
      vi.stubGlobal('window', undefined);
      restores.push(setEnv('API_URL', undefined));
      restores.push(setEnv('NEXT_PUBLIC_API_URL', undefined));
      expect(resolveApiBaseUrl()).toBe('');
    });
  });
});

describe('resolveWsBaseUrl', () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
    vi.unstubAllGlobals();
    delete (globalThis as MutableGlobal).__APP_CONFIG__;
  });

  it('an explicit override wins and is normalized to ws(s) (client and server)', () => {
    expect(resolveWsBaseUrl('https://explicit.example')).toBe('wss://explicit.example');
    expect(resolveWsBaseUrl('http://explicit.example')).toBe('ws://explicit.example');
    // An already-ws(s) override passes through untouched.
    expect(resolveWsBaseUrl('wss://ws.example')).toBe('wss://ws.example');
    vi.stubGlobal('window', undefined);
    expect(resolveWsBaseUrl('https://explicit.example')).toBe('wss://explicit.example');
  });

  describe('on the client (window defined)', () => {
    it('derives the ws origin from a configured NEXT_PUBLIC_API_URL (scheme swapped)', () => {
      restores.push(setEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000'));
      expect(resolveWsBaseUrl()).toBe('ws://localhost:4000');
    });

    it('honours a runtime-injected window.__APP_CONFIG__.apiUrl over the build-time value', () => {
      restores.push(setEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000'));
      (globalThis as MutableGlobal).__APP_CONFIG__ = { apiUrl: 'https://api.example.com' };
      expect(resolveWsBaseUrl()).toBe('wss://api.example.com');
    });

    it('defaults to the SAME ORIGIN from window.location when nothing is configured', () => {
      restores.push(setEnv('NEXT_PUBLIC_API_URL', undefined));
      // https page -> wss, http page -> ws; the page host is kept, nothing baked.
      vi.stubGlobal('window', { location: { protocol: 'https:', host: 'app.example.com' } });
      expect(resolveWsBaseUrl()).toBe('wss://app.example.com');
      vi.stubGlobal('window', { location: { protocol: 'http:', host: 'app.example.com:3000' } });
      expect(resolveWsBaseUrl()).toBe('ws://app.example.com:3000');
    });
  });

  describe('on the server (window undefined)', () => {
    it('returns "" with no configured base (the socket is only created in the browser)', () => {
      vi.stubGlobal('window', undefined);
      restores.push(setEnv('API_URL', undefined));
      restores.push(setEnv('NEXT_PUBLIC_API_URL', undefined));
      expect(resolveWsBaseUrl()).toBe('');
    });
  });
});

describe('getPublicRuntimeConfig', () => {
  it('reads PUBLIC_API_URL at call time, defaulting to same origin ("")', () => {
    const restore = setEnv('PUBLIC_API_URL', undefined);
    try {
      expect(getPublicRuntimeConfig()).toEqual({ apiUrl: '' });
      process.env.PUBLIC_API_URL = 'https://api.example.com';
      expect(getPublicRuntimeConfig()).toEqual({ apiUrl: 'https://api.example.com' });
    } finally {
      restore();
    }
  });
});

describe('joinApiUrl', () => {
  it('joins a base and a path, tolerating slashes', () => {
    expect(joinApiUrl('http://localhost:4000', '/healthz')).toBe('http://localhost:4000/healthz');
    expect(joinApiUrl('http://localhost:4000/', 'healthz')).toBe('http://localhost:4000/healthz');
  });

  it('produces a relative same-origin path for an empty base', () => {
    expect(joinApiUrl('', '/healthz')).toBe('/healthz');
    expect(joinApiUrl('', 'api/users')).toBe('/api/users');
  });

  it('passes an already-absolute path through unchanged', () => {
    expect(joinApiUrl('http://localhost:4000', 'https://other.example/x')).toBe(
      'https://other.example/x',
    );
  });
});
