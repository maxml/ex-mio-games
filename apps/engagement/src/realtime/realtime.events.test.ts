import { createEvent } from '@ex-mio/contracts';
import { toPush } from './realtime.events';

const T = '11111111-1111-4111-8111-111111111111';
const P = '33333333-3333-4333-8333-333333333333';
const id = '66666666-6666-4666-8666-666666666666';

describe('toPush', () => {
  it('targets the envelope tenant and the payload player, and only for events a player hears', () => {
    const spin = createEvent({
      type: 'engagement.spin.completed',
      tenantId: T,
      sandbox: false,
      payload: { spin_id: id, player_id: P, reward_coins: 3, table_version: 2 },
    });
    expect(toPush(spin)).toMatchObject({
      tenantId: T,
      playerId: P,
      frame: { type: 'spin.result' },
    });
    const other = createEvent({
      type: 'identity.tenant.created',
      tenantId: T,
      sandbox: false,
      payload: { name: 'n', slug: 's' },
    });
    expect(toPush(other)).toBeUndefined();
  });

  it('a credit has no balances: the frame carries the amount only', () => {
    const e = createEvent({
      type: 'payments.coins.credited',
      tenantId: T,
      sandbox: false,
      payload: { credit_id: id, player_id: P, amount: 9 },
    });
    expect(toPush(e)?.frame.payload).toEqual({ reason: 'credited', amount: 9 });
  });
});
