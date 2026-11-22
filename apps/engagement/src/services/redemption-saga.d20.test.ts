import { RedemptionSagaService } from './redemption-saga.service';
import { World } from '../redemptions/testing/world';
import type { RedemptionRecord, Scope } from '../redemptions/ports';

/*
 * D-20 (L2 Stage B review answers, Q-1): a late capture on a refunded reserve gets
 * `reserve_already_refunded`. L4 treats that code as CONSISTENT, with no review, when its own order
 * is already RELEASED or REFUNDED; in any other state it goes to review.
 *
 * Mutation: send every `reserve_already_refunded` on a capture to review (drop the re-read of the
 * order in `RedemptionSagaService.capture`) -> the first test goes red; always treat it as
 * consistent -> the second goes red.
 */

const P1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f0001';
const make = (deps: ConstructorParameters<typeof RedemptionSagaService>[0]) =>
  new RedemptionSagaService(deps);
type W = World<RedemptionSagaService>;

function setup() {
  const w: W = new World(make);
  w.payments.credit(P1, 100);
  const item = w.store.addItem({ price: 10, stock: 5, perPlayerLimit: null });
  return { w, item };
}
const scope = (w: W): Scope => ({ tenantId: w.tenant, playerId: P1, sandbox: false });
const rec = (w: W, id: string): RedemptionRecord => w.store.redemptions.get(id)!;

describe('D-20: reserve_already_refunded on a capture', () => {
  it('is consistent (no review, no event) when the order is already REFUNDED', async () => {
    const { w, item } = setup();
    const r = (await w.saga.redeem(scope(w), 'k-d20-a', item.id)).redemption;
    await w.settle(1);
    expect(rec(w, r.id).state).toBe('ISSUED');
    // a concurrent path completes and refunds the order while this capture is in flight
    jest.spyOn(w.payments, 'capture').mockImplementationOnce(async () => {
      await w.store.apply(w.tenant, r.id, {
        expectFrom: ['ISSUED'],
        to: 'COMPLETED',
        cause: 'captured',
        reservation: 'commit',
      });
      await w.store.apply(w.tenant, r.id, {
        expectFrom: ['COMPLETED'],
        to: 'REFUNDED',
        cause: 'refunded',
      });
      return { ok: false, code: 'reserve_already_refunded' };
    });
    await w.settle(1);
    expect(rec(w, r.id).state).toBe('REFUNDED');
    expect(w.events('engagement.redemption.needs_review')).toHaveLength(0);
  });

  it('goes to review when the order is in any other state (ISSUED)', async () => {
    const { w, item } = setup();
    const r = (await w.saga.redeem(scope(w), 'k-d20-b', item.id)).redemption;
    await w.settle(1);
    expect(rec(w, r.id).state).toBe('ISSUED');
    jest
      .spyOn(w.payments, 'capture')
      .mockResolvedValueOnce({ ok: false, code: 'reserve_already_refunded' });
    await w.settle(1);
    expect(rec(w, r.id).state).toBe('NEEDS_REVIEW');
    expect(rec(w, r.id).history.at(-1)?.cause).toContain('reserve_already_refunded');
  });
});
