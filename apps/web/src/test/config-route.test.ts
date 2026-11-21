import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../../app/config/route';

// The `/config` route surfaces the browser-facing runtime config, resolved from
// `PUBLIC_API_URL` at REQUEST time (force-dynamic) — proving the image is
// domain-agnostic (no baked value). Empty means "same origin".
describe('web /config route', () => {
  const previous = process.env.PUBLIC_API_URL;

  afterEach(() => {
    if (previous === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = previous;
  });

  it('returns 200 with an empty apiUrl (same origin) when PUBLIC_API_URL is unset', async () => {
    delete process.env.PUBLIC_API_URL;
    const res = GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('no-store');
    await expect(res.json()).resolves.toEqual({ apiUrl: '' });
  });

  it('reflects the runtime PUBLIC_API_URL when set (runtime, not baked)', async () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    const res = GET();

    await expect(res.json()).resolves.toEqual({ apiUrl: 'https://api.example.com' });
  });
});
