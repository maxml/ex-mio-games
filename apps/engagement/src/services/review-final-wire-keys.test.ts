import { scopedKey } from '@ex-mio/contracts';
import { RedemptionSagaService } from './redemption-saga.service';
import { World } from '../redemptions/testing/world';

/*
 * Final review (question 2): the coder rewrote the frozen saga tests' literal keys (`hold:${id}`,
 * `redeem:${id}`, ...) through a new helper `okey` that calls `scopedKey`, the same function the
 * saga calls. Those tests still pin "one stable key per phase, reused on every retry", but they no
 * longer pin the KEY ITSELF. The key is a wire contract: payments stores the reserve under it, and
 * the casino dedupes issuance and answers the status lookup by it (D-2). A change of the format
 * moves the key of every order that is in flight at the upgrade, and a status lookup under the new
 * key answers `not_found` for a reward issued under the old one (past the deadline: a refund of a
 * reward that was issued).
 *
 * These goldens are written by hand, not derived from scopedKey, so a format change goes red here.
 * Mutation (re-applied in the review): scoped-key.ts writes `prod` instead of `prd`
 *   -> WIRE-KEY-1 and WIRE-KEY-2 red; every okey-based saga test stays green.
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b'; // World.tenant
const P1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0001';

describe('final review: the idempotency keys on the wire are pinned literally', () => {
  it('WIRE-KEY-1 a production order sends hold/redeem/capture keys of the form <kind>:<tenant>:prd:<order id>', async () => {
    const w = new World((deps) => new RedemptionSagaService(deps));
    expect(w.tenant).toBe(T);
    w.payments.credit(P1, 100);
    const item = w.store.addItem({ price: 10, stock: 5, perPlayerLimit: null });
    const r = (await w.saga.redeem({ tenantId: T, playerId: P1, sandbox: false }, 'k1', item.id))
      .redemption;
    await w.settle();
    expect(w.store.redemptions.get(r.id)?.state).toBe('COMPLETED');
    expect(w.payments.callsOf('reserve').map((c) => c.key)).toEqual([`hold:${T}:prd:${r.id}`]);
    expect(w.casino.issueCalls.map((c) => c.key)).toEqual([`redeem:${T}:prd:${r.id}`]);
    expect(w.payments.callsOf('capture').map((c) => c.key)).toEqual([`capture:${T}:prd:${r.id}`]);
  });

  it('WIRE-KEY-2 the usage report key sent to the billing provider is usage:<tenant>:prd:<period>', () => {
    // payments usage.service.ts builds exactly this call; its pgtests now derive the expectation
    // from scopedKey too, so this is the only literal pin of the provider's idempotency key.
    expect(scopedKey({ kind: 'usage', tenantId: T, sandbox: false, parts: ['2026-11'] })).toBe(
      `usage:${T}:prd:2026-11`,
    );
    expect(scopedKey({ kind: 'redeem', tenantId: T, sandbox: true, parts: [P1] })).toBe(
      `redeem:${T}:sbx:${P1}`,
    );
  });
});
