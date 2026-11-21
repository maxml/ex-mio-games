import {
  ALLOWED_RESERVE_TRANSITIONS,
  CreditCoinsRequest,
  ReserveCoinsRequest,
  ReserveRefRequest,
  createEvent,
  parseEvent,
} from './index';

const U = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

// Contract tests: these pin the wire shapes and pass already. The RED tests of the
// payments epic live in apps/payments (see docs/specs/payments.md).
describe('payments contracts', () => {
  // Mutation: relax CoinAmount (drop .int(), .positive() or .max()) -> a row below goes red.
  it.each([0, -1, 1.5, '10', 1_000_000_000_001, null])('rejects coin amount %p', (amount) => {
    expect(
      ReserveCoinsRequest.safeParse({ player_id: U, reserve_id: U, amount, currency: 'COIN' })
        .success,
    ).toBe(false);
    expect(
      CreditCoinsRequest.safeParse({ player_id: U, spin_id: U, amount, currency: 'COIN' }).success,
    ).toBe(false);
  });

  it('accepts the upper bound and rejects another currency', () => {
    const ok = { player_id: U, reserve_id: U, amount: 1_000_000_000_000 };
    expect(ReserveCoinsRequest.safeParse(ok).success).toBe(true);
    expect(ReserveCoinsRequest.safeParse({ ...ok, currency: 'USD' }).success).toBe(false);
  });

  // Mutation: remove .strict() from ReserveRefRequest -> capture could carry an amount.
  it('capture, release and refund take no amount', () => {
    expect(ReserveRefRequest.safeParse({ reserve_id: U }).success).toBe(true);
    expect(ReserveRefRequest.safeParse({ reserve_id: U, amount: 5 }).success).toBe(false);
  });

  it('only a reserved reserve can be captured or released; only captured can be refunded', () => {
    expect(ALLOWED_RESERVE_TRANSITIONS).toEqual({
      reserved: ['captured', 'released'],
      captured: ['refunded'],
      released: [],
      refunded: [],
    });
  });

  it('registers the four coin phase events and validates their payloads', () => {
    const payload = {
      transaction_id: U,
      player_id: U,
      wallet_id: U,
      reserve_id: U,
      amount: 5,
      available_after: 0,
      held_after: 5,
    };
    for (const type of [
      'payments.coins.reserved',
      'payments.coins.captured',
      'payments.coins.released',
      'payments.coins.refunded',
    ] as const) {
      const e = createEvent({ type, tenantId: U, payload });
      expect(parseEvent(e).type).toBe(type);
      expect(() => parseEvent({ ...e, payload: { ...payload, amount: 0 } })).toThrow();
    }
  });
});
