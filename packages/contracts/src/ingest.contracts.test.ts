import {
  CanonicalDepositEvent,
  PublicWheel,
  RewardTableDefinition,
  RuleDefinition,
  MySpinsResponse,
  SPIN_CONFLICT_CODES,
  SpinConflictBody,
  SpinResponse,
  SpinRequest,
  createEvent,
  parseEvent,
} from './index';

// Pins the L3 schemas (docs/specs/engagement-ingest.md). These pass at Stage A by design: the
// schemas are the contract. Mutation for each: loosen the named schema line, the test goes red.

const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const W = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';

const canonical = {
  tenant_id: T,
  source: 'casino-a',
  external_event_id: 'e1',
  type: 'deposit.succeeded',
  external_player_id: 'p1',
  amount_minor: 5000,
  currency: 'EUR',
  occurred_at: '2026-11-21T10:00:00.000Z',
};

describe('ingest contracts', () => {
  // INV-ING-INT-AMOUNT. Mutation: z.number().int() -> z.number() in CanonicalDepositEvent.
  it('INV-ING-INT-AMOUNT: a float or zero amount is not a canonical event', () => {
    expect(CanonicalDepositEvent.safeParse(canonical).success).toBe(true);
    expect(CanonicalDepositEvent.safeParse({ ...canonical, amount_minor: 10.5 }).success).toBe(
      false,
    );
    expect(CanonicalDepositEvent.safeParse({ ...canonical, amount_minor: 0 }).success).toBe(false);
  });

  // INV-EVT-REGISTERED. Mutation: remove the engagement.deposit.confirmed entry in EVENT_SCHEMAS.
  it('INV-EVT-REGISTERED: deposit.confirmed and spin.granted are registered, tenant-carrying events', () => {
    const e = createEvent({
      type: 'engagement.deposit.confirmed',
      tenantId: T,
      payload: {
        inbound_event_id: W,
        source: 'casino-a',
        external_event_id: 'e1',
        player_id: W, // D-12 / F1: the internal id only
        amount_minor: 5000,
        currency: 'EUR',
        occurred_at: canonical.occurred_at,
      },
    });
    expect(parseEvent(e).tenant_id).toBe(T);
    // F1 choke point: the raw casino id cannot be put on the event at all (strict payload).
    const deposit = {
      inbound_event_id: W,
      source: 'casino-a',
      external_event_id: 'e1',
      player_id: W,
      amount_minor: 5000,
      currency: 'EUR',
      occurred_at: canonical.occurred_at,
    };
    for (const bad of [
      { ...deposit, external_player_id: 'p1' },
      { ...deposit, player_id: 'p1' }, // a raw id in the player_id slot
      { ...deposit, player_id: undefined },
    ]) {
      expect(() =>
        createEvent({ type: 'engagement.deposit.confirmed', tenantId: T, payload: bad as never }),
      ).toThrow();
    }
    expect(() =>
      createEvent({
        type: 'engagement.spin.granted',
        tenantId: T,
        payload: { credit_id: W, player_id: W, wheel_id: W, source_event_id: 'not-a-uuid' },
      }),
    ).toThrow();
  });

  // INV-RULE-SCHEMA. Mutation: drop .min(1) on action.spins or .strict() on RuleDefinition.
  it('INV-RULE-SCHEMA: unknown action, negative or zero spins and extra fields are rejected', () => {
    const rule = {
      name: 'r',
      trigger: 'deposit.succeeded',
      conditions: { min_amount_minor: 1000 },
      action: { type: 'grant_spins', spins: 1, wheel_id: W },
      active_from: '2026-11-01T00:00:00.000Z',
      active_to: null,
      max_grants_per_player: null,
    };
    expect(RuleDefinition.safeParse(rule).success).toBe(true);
    expect(
      RuleDefinition.safeParse({ ...rule, action: { ...rule.action, type: 'eval' } }).success,
    ).toBe(false);
    expect(
      RuleDefinition.safeParse({ ...rule, action: { ...rule.action, spins: -1 } }).success,
    ).toBe(false);
    expect(
      RuleDefinition.safeParse({ ...rule, action: { ...rule.action, spins: 0 } }).success,
    ).toBe(false);
    expect(RuleDefinition.safeParse({ ...rule, expr: '1==1' }).success).toBe(false);
  });

  // INV-WHEEL-WEIGHTS. Mutation: .positive() -> .nonnegative() on RewardSegment.weight.
  it('INV-WHEEL-WEIGHTS: zero, negative, fractional weights, no segments or oversize total are rejected', () => {
    const seg = (weight: number) => ({
      label: 'x',
      weight,
      reward: { type: 'coins', amount: 5 },
    });
    const table = (segments: unknown[]) => ({ name: 't', segments });
    expect(RewardTableDefinition.safeParse(table([seg(1), seg(9)])).success).toBe(true);
    expect(RewardTableDefinition.safeParse(table([seg(0), seg(9)])).success).toBe(false);
    expect(RewardTableDefinition.safeParse(table([seg(-1), seg(9)])).success).toBe(false);
    expect(RewardTableDefinition.safeParse(table([seg(1.5)])).success).toBe(false);
    expect(RewardTableDefinition.safeParse(table([])).success).toBe(false);
    expect(RewardTableDefinition.safeParse(table([seg(600_000), seg(600_000)])).success).toBe(
      false,
    );
  });

  // INV-SPIN-NO-CHOICE. Mutation: remove .strict() on SpinRequest.
  it('INV-SPIN-NO-CHOICE: a spin request carries no weights, segment, seed or table version', () => {
    expect(SpinRequest.safeParse({}).success).toBe(true);
    expect(SpinRequest.safeParse({ credit_id: W }).success).toBe(true);
    for (const extra of ['weights', 'segment', 'seed', 'table_version', 'table_id', 'user_id']) {
      expect(SpinRequest.safeParse({ [extra]: 1 }).success).toBe(false);
    }
  });

  // INV-SPIN-RESPONSE-INDEX. Mutation: drop segment_index from SpinResponse or make it optional.
  it('INV-SPIN-RESPONSE-INDEX: a spin response carries the winning segment_index, label and coins', () => {
    const ok = { spin_id: W, segment_index: 2, segment_label: 'Win', reward_coins: 25 };
    expect(SpinResponse.safeParse(ok).success).toBe(true);
    const { segment_index: _drop, ...without } = ok;
    expect(SpinResponse.safeParse(without).success).toBe(false);
    expect(SpinResponse.safeParse({ ...ok, segment_index: -1 }).success).toBe(false);
    expect(SpinResponse.safeParse({ ...ok, segment_index: 0.5 }).success).toBe(false);
    expect(SpinResponse.safeParse({ ...ok, weight: 3 }).success).toBe(false);
  });

  // INV-ME-SPINS-SHAPE. Mutation: allow extra fields (a user id, a credit list) or a negative count.
  it('INV-ME-SPINS-SHAPE: GET /v1/me/spins answers a non-negative integer count and nothing else', () => {
    expect(MySpinsResponse.safeParse({ available: 0 }).success).toBe(true);
    expect(MySpinsResponse.safeParse({ available: 3 }).success).toBe(true);
    for (const bad of [{ available: -1 }, { available: 1.5 }, {}, { available: 1, user_id: W }]) {
      expect(MySpinsResponse.safeParse(bad).success).toBe(false);
    }
  });

  // INV-SPIN-CONFLICT-CODE (R2-5). Mutation: add a third code, or make `code` optional.
  it('INV-SPIN-CONFLICT-CODE: a spin 409 is `in_progress` (retry) or `no_credit` (stop), nothing else', () => {
    expect([...SPIN_CONFLICT_CODES]).toEqual(['in_progress', 'no_credit']);
    expect(SpinConflictBody.safeParse({ message: 'm', code: 'in_progress' }).success).toBe(true);
    expect(SpinConflictBody.safeParse({ message: 'm', code: 'no_credit' }).success).toBe(true);
    expect(SpinConflictBody.safeParse({ message: 'm' }).success).toBe(false);
    expect(SpinConflictBody.safeParse({ message: 'm', code: 'conflict' }).success).toBe(false);
  });

  // INV-WHEEL-PUBLIC-NO-WEIGHTS. Mutation: remove .strict() on PublicWheel segments.
  it('INV-WHEEL-PUBLIC-NO-WEIGHTS: the player view cannot carry a weight', () => {
    expect(PublicWheel.safeParse({ wheel_id: W, segments: [{ label: 'a' }] }).success).toBe(true);
    expect(
      PublicWheel.safeParse({ wheel_id: W, segments: [{ label: 'a', weight: 5 }] }).success,
    ).toBe(false);
  });
});
