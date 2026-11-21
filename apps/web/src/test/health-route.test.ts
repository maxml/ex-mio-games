import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../../app/health/route';

// The web `/health` route is the readiness probe Deckhand's blue-green cutover
// gates on for the web service (the API answers `/healthz` for itself). It must
// stay dependency-free and always return a bare 200 JSON body, and reports the
// running build's `version`, read from `APP_VERSION` at RUNTIME (force-dynamic).
describe('web /health route', () => {
  const previousVersion = process.env.APP_VERSION;

  afterEach(() => {
    if (previousVersion === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = previousVersion;
  });

  it('returns 200 with an ok status and a null version when APP_VERSION is unset', async () => {
    delete process.env.APP_VERSION;
    const res = GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('no-store');
    await expect(res.json()).resolves.toEqual({ status: 'ok', version: null });
  });

  it('reports the runtime APP_VERSION when set (runtime, not baked)', async () => {
    process.env.APP_VERSION = '1.2.3';
    const res = GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok', version: '1.2.3' });
  });
});
