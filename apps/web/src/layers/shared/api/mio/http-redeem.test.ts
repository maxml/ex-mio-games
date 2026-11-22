import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw/server';
import { createHttpClient } from '../http';
import { createHttpApi } from './http';

// W-6 (contracts reconciliation): a redemption is a money-like write, so it behaves like a spin.
// One user action is one Idempotency-Key, kept while the outcome is unknown and dropped on a
// definite answer; `idempotency_in_progress` (409) is retried on the same key; the business 409s of
// the store (`insufficient_funds`, `out_of_stock`, `limit_reached`, `item_inactive`,
// `illegal_transition`) are the definite answer `redeem_refused`, never a retry and never `invalid`.
// A lost reply must not become a second order.
// Mutation: mint a new key per call (`[HEADER_IDEMPOTENCY_KEY]: idempotencyKey()` inline, as today)
// and the key tests go red; map every 409 to `invalid` (as `call()` does today) and the code tests go red.

const ORDER = { id: 'rd_1', itemId: 's1', item: 'Spins', coins: 300, status: 'pending' };

function setup(replies: Array<{ status: number; body: unknown }>) {
  const keys: Array<string | null> = [];
  let i = 0;
  server.use(
    http.post('*/api/player/redemptions', ({ request }) => {
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

describe('http redeem: idempotency key and error mapping', () => {
  it('a lost reply (5xx) is "network-or-server" and the retry carries the SAME key: no second order', async () => {
    const { api, keys } = setup([
      { status: 503, body: { message: 'down', code: 'unavailable' } },
      { status: 202, body: ORDER },
    ]);
    expect(await code(api.player.redeem('s1'))).toBe('network-or-server');
    await expect(api.player.redeem('s1')).resolves.toEqual(ORDER);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('a new action after a success gets a new key', async () => {
    const { api, keys } = setup([{ status: 202, body: ORDER }]);
    await api.player.redeem('s1');
    await api.player.redeem('s1');
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a 409 idempotency_in_progress is retried with backoff on the same key and then succeeds', async () => {
    const busy = { status: 409, body: { message: 'in progress', code: 'idempotency_in_progress' } };
    const { api, keys } = setup([busy, busy, { status: 202, body: ORDER }]);
    await expect(api.player.redeem('s1')).resolves.toEqual(ORDER);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('a 409 that never clears ends as "retryable" (bounded)', async () => {
    const busy = { status: 409, body: { message: 'in progress', code: 'idempotency_in_progress' } };
    const { api, keys } = setup([busy]);
    expect(await code(api.player.redeem('s1'))).toBe('retryable');
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.length).toBeLessThanOrEqual(6);
    expect(new Set(keys).size).toBe(1);
  });

  it.each([
    'insufficient_funds',
    'out_of_stock',
    'limit_reached',
    'item_inactive',
    'illegal_transition',
  ])(
    'the business answer %s is "redeem_refused", it ends the action (new key next) and is not retried',
    async (serverCode) => {
      const { api, keys } = setup([
        { status: 409, body: { message: serverCode, code: serverCode } },
        { status: 202, body: ORDER },
      ]);
      expect(await code(api.player.redeem('s1'))).toBe('redeem_refused');
      expect(keys).toHaveLength(1);
      await api.player.redeem('s1');
      expect(keys[1]).not.toBe(keys[0]);
    },
  );

  it('the status words are the store public words: failed_refunded is accepted, the old "refunded" is a bad response', async () => {
    const ok = setup([{ status: 202, body: { ...ORDER, status: 'failed_refunded' } }]);
    await expect(ok.api.player.redeem('s1')).resolves.toMatchObject({ status: 'failed_refunded' });
    const old = setup([{ status: 202, body: { ...ORDER, status: 'refunded' } }]);
    expect(await code(old.api.player.redeem('s1'))).toBe('bad_response');
  });
});
