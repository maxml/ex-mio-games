import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw/server';
import { createHttpClient } from '../http';
import { createHttpApi } from './http';

// F2: one idempotency key per user action, reused on every retry; errors are never turned into
// "no spins" unless the server said so with the explicit no-credit code.
// Mutation: in `spin`, mint a new key per attempt (`const key = idempotencyKey()`) and the key tests
// go red; map every 409 to `no_spins` (or 5xx to `invalid`) and the error-code tests go red.

const WON = { id: 'spin_1', index: 2, coins: 50 };

function setup(replies: Array<{ status: number; body: unknown }>) {
  const keys: Array<string | null> = [];
  let i = 0;
  server.use(
    http.post('*/api/player/spins', ({ request }) => {
      keys.push(request.headers.get('idempotency-key'));
      const r = replies[Math.min(i++, replies.length - 1)]!;
      return HttpResponse.json(r.body, { status: r.status });
    }),
  );
  return { api: createHttpApi(createHttpClient({ baseUrl: 'http://api.test' })), keys };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code: string }) => e.code,
  );

describe('http spin: idempotency key and error mapping', () => {
  it('a 5xx is "network-or-server", never "no_spins", and the retry carries the same key', async () => {
    const { api, keys } = setup([
      { status: 500, body: { message: 'boom', code: 'internal' } },
      { status: 201, body: WON },
    ]);
    expect(await code(api.player.spin())).toBe('network-or-server');
    await expect(api.player.spin()).resolves.toEqual(WON);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('a new action after a success gets a new key', async () => {
    const { api, keys } = setup([{ status: 201, body: WON }]);
    await api.player.spin();
    await api.player.spin();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a 409 in flight is retried with backoff on the same key and then succeeds', async () => {
    const inFlight = {
      status: 409,
      body: { message: 'in progress', code: 'idempotency_in_progress' },
    };
    const { api, keys } = setup([inFlight, inFlight, { status: 201, body: WON }]);
    await expect(api.player.spin()).resolves.toEqual(WON);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('a 409 that never clears ends as "retryable" (bounded), not "no_spins"', async () => {
    const inFlight = {
      status: 409,
      body: { message: 'in progress', code: 'idempotency_in_progress' },
    };
    const { api, keys } = setup([inFlight]);
    expect(await code(api.player.spin())).toBe('retryable');
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.length).toBeLessThanOrEqual(6);
    expect(new Set(keys).size).toBe(1);
  });

  it('"no_spins" only for the explicit no-credit code, and that answer ends the action (new key next)', async () => {
    const { api, keys } = setup([
      { status: 409, body: { message: 'no credit', code: 'no_credit' } },
      { status: 201, body: WON },
    ]);
    expect(await code(api.player.spin())).toBe('no_spins');
    await api.player.spin();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
