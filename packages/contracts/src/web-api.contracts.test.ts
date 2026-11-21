import { ActAsTenantRequest, PlayerState, RedeemRequest, SpinResultView } from './index';

const player = {
  coins: 420,
  spins: 3,
  wheel: [
    { id: 's1', label: '10' },
    { id: 's2', label: '25' },
  ],
  store: [
    { id: 'i1', name: '20 free spins', description: 'd', priceCoins: 300, kind: 'free_spins' },
  ],
  history: [],
  redemptions: [],
  lastSpin: null,
  casinoDown: false,
};

describe('web API contracts', () => {
  it('accepts a well-formed player state', () => {
    expect(PlayerState.parse(player).coins).toBe(420);
  });

  it('a negative balance or a one-segment wheel is rejected', () => {
    expect(() => PlayerState.parse({ ...player, coins: -1 })).toThrow();
    expect(() => PlayerState.parse({ ...player, wheel: [player.wheel[0]] })).toThrow();
  });

  it('the widget never receives odds: a wheel segment with a weight is stripped, not trusted', () => {
    const parsed = PlayerState.parse({
      ...player,
      wheel: [{ id: 's1', label: '10', weight: 99 }, player.wheel[1]],
    });
    expect(parsed.wheel[0]).toEqual({ id: 's1', label: '10' });
  });

  it('a spin result carries an id and a segment index', () => {
    expect(() => SpinResultView.parse({ index: 1, coins: 5 })).toThrow();
    expect(SpinResultView.parse({ id: 'sp-1', index: 1, coins: 5 })).toEqual({
      id: 'sp-1',
      index: 1,
      coins: 5,
    });
  });

  it('redeem needs an item id', () => {
    expect(() => RedeemRequest.parse({ itemId: '' })).toThrow();
  });

  it('acting as a tenant needs a real reason (audited)', () => {
    expect(() => ActAsTenantRequest.parse({ tenantId: 't1', reason: 'x' })).toThrow();
    expect(
      ActAsTenantRequest.parse({ tenantId: 't1', reason: 'Support ticket 1042' }).tenantId,
    ).toBe('t1');
  });
});
