import * as contracts from './index';
import {
  ALLOWED_ATTEMPT_TRANSITIONS,
  ALLOWED_RESERVE_TRANSITIONS,
  COIN_COMMANDS,
  CreateAttemptRequest,
  PAYMENT_ATTEMPT_STATES,
  PaymentAttempt,
  COIN_VALUE_ACTIONS,
  PAYMENTS_ERROR_CODES,
  RESERVE_COMMAND_OUTCOMES,
  RESERVE_STATES,
  ReserveCoinsRequest,
  ReserveIdParam,
  ReserveRefRequest,
  SubscribeRequest,
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
      ReserveCoinsRequest.safeParse({
        player_id: U,
        reserve_id: U,
        amount,
        currency: 'COIN',
        sandbox: false,
      }).success,
    ).toBe(false);
  });

  // Mutation: re-add a CreditCoinsRequest (an HTTP credit body) to the contracts (D-1).
  it('has no HTTP credit body: spin coins only arrive as engagement.spin.completed', () => {
    expect(Object.keys(contracts).filter((k) => /^Credit.*Request$/.test(k))).toEqual([]);
    expect(COIN_COMMANDS).toEqual(['reserve', 'capture', 'release', 'refund']);
  });

  // Mutation: add or drop an action without updating the acting-tenant guard test (D-5).
  it('pins the list of coin-value actions the acting_tenant ban covers', () => {
    expect(COIN_VALUE_ACTIONS).toEqual(['credit', 'reserve', 'capture', 'release', 'refund']);
  });

  // Mutation: change one cell of RESERVE_COMMAND_OUTCOMES, or reintroduce invalid_reserve_transition.
  it('the reserve outcome table agrees with the allowed transitions and uses defined codes', () => {
    const target = { capture: 'captured', release: 'released', refund: 'refunded' } as const;
    for (const state of RESERVE_STATES) {
      for (const cmd of ['capture', 'release', 'refund'] as const) {
        const outcome: string = RESERVE_COMMAND_OUTCOMES[state][cmd];
        const allowed = (ALLOWED_RESERVE_TRANSITIONS[state] as readonly string[]).includes(
          target[cmd],
        );
        if (allowed) expect(outcome).toBe('apply');
        else if (state === target[cmd]) expect(outcome).toBe('replay');
        else expect(Object.keys(PAYMENTS_ERROR_CODES)).toContain(outcome);
      }
    }
    expect(Object.keys(PAYMENTS_ERROR_CODES)).not.toContain('invalid_reserve_transition');
  });

  // Mutation: accept a card number in SubscribeRequest again.
  it('subscribe takes a provider token and refuses a card number', () => {
    expect(SubscribeRequest.safeParse({ plan_id: U, payment_method: 'tok_4242' }).success).toBe(
      true,
    );
    expect(
      SubscribeRequest.safeParse({ plan_id: U, card_number: '4242424242424242' }).success,
    ).toBe(false);
    expect(
      SubscribeRequest.safeParse({ plan_id: U, payment_method: '4242424242424242' }).success,
    ).toBe(false);
  });

  // Mutation: let a terminal attempt state move, or store more than last4 and brand in PaymentAttempt.
  it('payment attempts: only processing can change; the model holds last4 and brand, no card number', () => {
    expect(ALLOWED_ATTEMPT_TRANSITIONS).toEqual({
      processing: ['succeeded', 'declined', 'cancelled'],
      succeeded: [],
      declined: [],
      cancelled: [],
    });
    expect(PAYMENT_ATTEMPT_STATES).toEqual(['processing', 'succeeded', 'declined', 'cancelled']);
    expect(
      Object.keys(PaymentAttempt.shape)
        .filter((k) => /card/.test(k))
        .sort(),
    ).toEqual(['card_brand', 'card_last4']);
    expect(
      CreateAttemptRequest.safeParse({ plan_id: U, card_number: '4242424242424242' }).success,
    ).toBe(true);
    expect(
      CreateAttemptRequest.safeParse({ plan_id: U, card_number: '4242', extra: 1 }).success,
    ).toBe(false);
  });

  // Mutation: drop `sandbox` from the envelope schema (zod would silently strip it).
  it('the envelope carries a producer-set sandbox flag; spin.completed carries table_version', () => {
    const e = createEvent({
      type: 'engagement.spin.completed',
      tenantId: U,
      sandbox: false,
      payload: { spin_id: U, player_id: U, reward_coins: 5, table_version: 3 },
    });
    expect(parseEvent({ ...e, sandbox: true }).sandbox).toBe(true);
    expect(parseEvent(e).sandbox).toBe(false);
  });

  it('accepts the upper bound and rejects another currency', () => {
    const ok = { player_id: U, reserve_id: U, amount: 1_000_000_000_000, sandbox: false };
    expect(ReserveCoinsRequest.safeParse(ok).success).toBe(true);
    expect(ReserveCoinsRequest.safeParse({ ...ok, currency: 'USD' }).success).toBe(false);
  });

  // X-4. Mutation: give `sandbox` a default or make it optional -> a reserve silently hits production.
  it('X-4: a reserve must name its wallet environment; there is no default', () => {
    const noFlag = { player_id: U, reserve_id: U, amount: 5 };
    expect(ReserveCoinsRequest.safeParse(noFlag).success).toBe(false);
    expect(ReserveCoinsRequest.safeParse({ ...noFlag, sandbox: true }).success).toBe(true);
    expect(ReserveCoinsRequest.safeParse({ ...noFlag, sandbox: 'true' }).success).toBe(false);
  });

  // X-9. Mutation: re-add a HEADER_* placeholder to payments.ts.
  it('X-9: payments contracts export no header placeholder', () => {
    expect(
      Object.keys(contracts).filter((k) => /^HEADER_(SERVICE|PRINCIPAL|ACTING)/.test(k)),
    ).toEqual([]);
  });

  // X-10. Mutation: drop acting_forbidden from PAYMENTS_ERROR_CODES.
  it('X-10: acting_forbidden is a 403 payments code', () => {
    expect(PAYMENTS_ERROR_CODES.acting_forbidden).toBe(403);
  });

  // Mutation: remove .strict() from ReserveRefRequest -> capture could carry an amount.
  it('capture, release and refund take an empty body: the reserve is in the path, the amount is its own', () => {
    expect(ReserveRefRequest.safeParse({}).success).toBe(true);
    expect(ReserveRefRequest.safeParse({ amount: 5 }).success).toBe(false);
    expect(ReserveRefRequest.safeParse({ reserve_id: U }).success).toBe(false);
    expect(ReserveRefRequest.safeParse({ tenant_id: U }).success).toBe(false);
    expect(ReserveIdParam.safeParse({ reserveId: U }).success).toBe(true);
    expect(ReserveIdParam.safeParse({ reserveId: 'x' }).success).toBe(false);
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
      const e = createEvent({ type, tenantId: U, sandbox: false, payload });
      expect(parseEvent(e).type).toBe(type);
      expect(() => parseEvent({ ...e, payload: { ...payload, amount: 0 } })).toThrow();
    }
  });
});
