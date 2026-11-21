import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PlayerState } from '../../types';
import { server } from '../../../../test/msw/server';
import { createHttpClient } from '../http';
import { MioApiError } from './api';
import { createHttpApi } from './http';
import { createIsolatedMockApi } from './mock';
import { resolveMioApiMode } from './select';

describe('adapter switch', () => {
  it('is the mock unless the env says http', () => {
    expect(resolveMioApiMode(undefined)).toBe('mock');
    expect(resolveMioApiMode('anything')).toBe('mock');
    expect(resolveMioApiMode('http')).toBe('http');
  });
});

describe('mock adapter returns contract-valid read models', () => {
  it('the player state satisfies the shared schema and never carries odds', async () => {
    const api = createIsolatedMockApi();
    const state = await api.player.getState();
    expect(PlayerState.safeParse(state).success).toBe(true);
    expect(JSON.stringify(state.wheel)).not.toMatch(/weight|probab/i);
  });

  it('a spin credits once and the next state shows it; with no spins left it fails with no_spins', async () => {
    const api = createIsolatedMockApi();
    const before = await api.player.getState();
    const result = await api.player.spin();
    const after = await api.player.getState();
    expect(after.spins).toBe(before.spins - 1);
    expect(after.coins).toBe(before.coins + result.coins);
    expect(after.lastSpin).toEqual(result);
    for (let i = 0; i < before.spins - 1; i++) await api.player.spin();
    await expect(api.player.spin()).rejects.toMatchObject({ code: 'no_spins' });
  });

  it('an operator price change reaches the player store; a hidden item disappears', async () => {
    const api = createIsolatedMockApi();
    await api.operator.setPrice('s1', 100);
    await api.operator.setVisible('s2', false);
    const state = await api.player.getState();
    expect(state.store.find((i) => i.id === 's1')?.priceCoins).toBe(100);
    expect(state.store.some((i) => i.id === 's2')).toBe(false);
    await expect(api.player.redeem('s2')).rejects.toBeInstanceOf(MioApiError);
  });

  it('go live is refused until the account, a paid plan and the sandbox are done', async () => {
    const api = createIsolatedMockApi();
    await expect(api.operator.startGoLive()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('acting as a tenant needs a reason and writes an audit entry', async () => {
    const api = createIsolatedMockApi();
    await expect(api.admin.actAsTenant({ tenantId: 't1', reason: 'x' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await api.admin.actAsTenant({ tenantId: 't1', reason: 'Support ticket 1042' });
    const overview = await api.admin.getOverview();
    expect(overview.audit).toHaveLength(1);
    expect(overview.audit[0]).toMatchObject({ tenantId: 't1', reason: 'Support ticket 1042' });
  });
});

describe('http adapter', () => {
  const api = createHttpApi(createHttpClient({ baseUrl: 'http://api.test' }));

  it('validates the response against the contract', async () => {
    server.use(http.get('*/api/player/state', () => HttpResponse.json({ coins: -5 })));
    await expect(api.player.getState()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('sends an idempotency key with a spin and returns the validated result', async () => {
    let key: string | null = null;
    server.use(
      http.post('*/api/player/spins', ({ request }) => {
        key = request.headers.get('idempotency-key');
        return HttpResponse.json({ id: 'sp-1', index: 2, coins: 50 });
      }),
    );
    await expect(api.player.spin()).resolves.toEqual({ id: 'sp-1', index: 2, coins: 50 });
    expect(key).toMatch(/[0-9a-f-]{36}/);
  });

  it('maps 403 to forbidden', async () => {
    server.use(
      http.get('*/api/platform/overview', () =>
        HttpResponse.json({ message: 'no' }, { status: 403 }),
      ),
    );
    await expect(api.admin.getOverview()).rejects.toMatchObject({ code: 'forbidden' });
  });
});
