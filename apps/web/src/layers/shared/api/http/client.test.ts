// Unit tests for the typed HTTP client with a mocked `fetch` (Vitest):
//   1. success (with + without schema validation)
//   2. HTTP non-2xx  -> HttpError envelope, NOT reported
//   3. network error -> HttpError envelope, reported via ErrorReporter
//   4. schema drift  -> validation_error envelope, reported
//   5. 204 No Content -> resolves undefined
//
// `reportError` is mocked at the same relative specifier the client imports it
// by, so we never touch the real ErrorReporter facade. The fetch is injected, so
// these tests never hit the MSW server wired in src/test/setup.ts.
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportError } from '../../../../../lib/error-reporter';
import { createHttpClient } from './client';
import { HttpError, isHttpError } from './errors';

// `vi.mock` is hoisted above the imports, so `./client` picks up the mock.
vi.mock('../../../../../lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const reportErrorMock = vi.mocked(reportError);
const BASE = 'https://api.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: Mock) {
  return createHttpClient({ baseUrl: BASE, fetch: fetchImpl as unknown as typeof fetch });
}

describe('createHttpClient', () => {
  beforeEach(() => {
    reportErrorMock.mockReset();
  });

  it('resolves the typed JSON body on success and builds the URL from the base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'u1', name: 'Ada' }));
    const client = makeClient(fetchMock);

    const data = await client.get<{ id: string; name: string }>('/users/u1');

    expect(data).toEqual({ id: 'u1', name: 'Ada' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/users/u1');
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('validates the body against a passed schema and returns the parsed value', async () => {
    const schema = {
      safeParse: (value: unknown) => ({ success: true as const, data: value as { ok: boolean } }),
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    const data = await client.get('/flag', { schema });

    expect(data).toEqual({ ok: true });
  });

  it('serialises the body and sets JSON headers on POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'u2' }, 201));
    const client = makeClient(fetchMock);

    await client.post('/users', { name: 'Grace' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Grace' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('maps a non-2xx response to an HttpError envelope without reporting it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Not found', code: 'user_not_found' }, 404));
    const client = makeClient(fetchMock);

    expect.assertions(5);
    try {
      await client.get('/users/missing');
    } catch (err) {
      expect(isHttpError(err)).toBe(true);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(404);
      expect(httpErr.code).toBe('user_not_found');
      expect(httpErr.message).toBe('Not found');
    }
    // HTTP errors are expected control flow, not unexpected failures.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('maps a network failure to a network_error envelope and reports it', async () => {
    const cause = new TypeError('Failed to fetch');
    const fetchMock = vi.fn().mockRejectedValue(cause);
    const client = makeClient(fetchMock);

    expect.assertions(5);
    try {
      await client.get('/users');
    } catch (err) {
      expect(isHttpError(err)).toBe(true);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(0);
      expect(httpErr.code).toBe('network_error');
    }
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(cause, expect.objectContaining({ scope: 'http' }));
  });

  it('maps a schema mismatch to a validation_error envelope and reports it', async () => {
    const issues = [{ path: ['name'], message: 'Required' }];
    const schema = {
      safeParse: () => ({ success: false as const, error: { issues } }),
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ wrong: true }));
    const client = makeClient(fetchMock);

    expect.assertions(4);
    try {
      await client.get('/users', { schema });
    } catch (err) {
      const httpErr = err as HttpError;
      expect(httpErr.code).toBe('validation_error');
      expect(httpErr.status).toBe(200);
      expect(httpErr.issues).toBe(issues);
    }
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });

  it('resolves undefined for a 204 No Content response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, 204));
    const client = makeClient(fetchMock);

    await expect(client.delete('/users/u1')).resolves.toBeUndefined();
  });

  // Base URL resolution is runtime + context-aware. On the SERVER an
  // empty base is a real misconfiguration (a relative fetch has no origin), so
  // it still throws config_error. On the CLIENT (browser) an empty base means
  // "same origin" — a relative path is emitted, never a throw.
  it('throws a config_error on the server when no base URL is available', async () => {
    const fetchMock = vi.fn();
    const client = createHttpClient({ fetch: fetchMock as unknown as typeof fetch });
    const previous = process.env.NEXT_PUBLIC_API_URL;
    const previousApi = process.env.API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.API_URL;
    // Simulate a server runtime (no DOM) so the resolver takes the server branch.
    vi.stubGlobal('window', undefined);

    try {
      await expect(client.get('/anything')).rejects.toMatchObject({
        code: 'config_error',
        status: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (previous !== undefined) process.env.NEXT_PUBLIC_API_URL = previous;
      if (previousApi !== undefined) process.env.API_URL = previousApi;
    }
  });

  it('falls back to a same-origin relative path on the client when no base is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createHttpClient({ fetch: fetchMock as unknown as typeof fetch });
    const previous = process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;

    try {
      await expect(client.get('/anything')).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/anything');
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_API_URL = previous;
    }
  });
});
