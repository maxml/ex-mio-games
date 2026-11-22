import type { RewardRequest } from '@ex-mio/contracts';
import type { Transport } from './adapter';
import { createCasinoA } from './casino-a.adapter';
import { createCasinoB } from './casino-b.adapter';

/*
 * D-30 (F1): "the failure reason is truncated and sanitised". The casino's rejection text becomes
 * `failure_reason` (`casino_rejected:<reason>`), stored on the order and shown to the operator. A
 * reward API the operator points anywhere (including an internal service, final-early F1) can put
 * any text there. The choke point is the adapter's result: every `rejected.reason` is at most 64
 * characters of `[A-Za-z0-9_.:-]`, whatever the body says.
 *
 * RED at e6f3ff4 for every case. Mutation for the fix: return `body.error` / `body.code` raw -> red.
 */

const HOSTILE =
  '<img src=x onerror=alert(1)>\u0000\n‮' + 'A'.repeat(5000) + ' Authorization: Bearer sk_live_x';

const REQUEST: RewardRequest = {
  external_player_id: 'ext-1',
  reward: { type: 'cash_bonus', amount_minor: 100, currency: 'EUR' },
  sandbox: false,
};

const fixed =
  (answers: Array<{ status: number; body: unknown }>): Transport =>
  async () =>
    answers.length > 1 ? answers.shift()! : answers[0]!;

const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;

describe('D30-REASON the casino rejection reason is truncated and sanitised (D-30, F1)', () => {
  it('D30-REASON-1 casino A: a 400 body error is not stored raw', async () => {
    const a = createCasinoA({
      baseUrl: 'https://casino-a.example',
      transport: fixed([{ status: 400, body: { error: HOSTILE } }]),
      sandbox: false,
    });
    const r = await a.issueReward(REQUEST, 'redeem:k');
    expect(r.kind).toBe('rejected');
    expect((r as { reason: string }).reason).toMatch(SAFE);
  });

  it('D30-REASON-2 casino B: a 422 body error is not stored raw', async () => {
    const b = createCasinoB({
      baseUrl: 'https://casino-b.example',
      transport: fixed([{ status: 422, body: { error: HOSTILE } }]),
      sandbox: false,
    });
    const r = await b.issueReward(REQUEST, 'redeem:k');
    expect(r.kind).toBe('rejected');
    expect((r as { reason: string }).reason).toMatch(SAFE);
  });

  it('D30-REASON-3 casino B: a FAILED ticket code from the status lookup is not stored raw', async () => {
    const b = createCasinoB({
      baseUrl: 'https://casino-b.example',
      transport: fixed([
        { status: 202, body: { ticket: 't-1' } },
        { status: 200, body: { state: 'FAILED', code: HOSTILE } },
      ]),
      sandbox: false,
    });
    const r = await b.getRewardStatus('redeem:k', REQUEST);
    expect(r.kind).toBe('rejected');
    expect((r as { reason: string }).reason).toMatch(SAFE);
  });
});
