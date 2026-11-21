import {
  CasinoRewardApiConfig,
  ISSUE_DEADLINE_MS_MAX,
  ISSUE_DEADLINE_MS_MIN,
  IssueResult,
  RECOVERY_MODES,
  ResolvedPortInfo,
  RewardRequest,
  RewardStatus,
  createEvent,
  parseEvent,
} from './index';

// Pins the single casino adapter port (decision D-2; docs/specs/engagement-ingest.md section 3).
// Green at Stage A by design: the schemas are the contract. Mutation for each: loosen the named
// schema (add `not_found` to IssueResult, drop `unknown` from RewardStatus, rename a field) and the
// named test goes red.

const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const SPIN = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const USER = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2d';

describe('casino adapter port', () => {
  it('INV-PORT-ISSUE-RESULT: issued | pending | rejected | unknown, with external_ref and reason', () => {
    for (const ok of [
      { kind: 'issued', external_ref: 'A-1' },
      { kind: 'pending', external_ref: 'T-1' },
      { kind: 'pending' },
      { kind: 'rejected', reason: 'LIMIT_REACHED' },
      { kind: 'unknown' },
    ]) {
      expect(IssueResult.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      { kind: 'not_found' }, // a status answer, never an issue answer
      { kind: 'issued', reference: 'A-1' }, // old field name
      { kind: 'issued' }, // no external_ref
      { kind: 'rejected', code: 'X' }, // old field name
      { kind: 'rejected' },
      { kind: 'unknown', note: 'timeout' },
    ]) {
      expect(IssueResult.safeParse(bad).success).toBe(false);
    }
  });

  it('INV-PORT-STATUS-RESULT: a status lookup is issued | pending | rejected | not_found | unknown', () => {
    for (const ok of [
      { kind: 'issued', external_ref: 'A-1' },
      { kind: 'pending' },
      { kind: 'pending', external_ref: 'T-1' },
      { kind: 'rejected', reason: 'LIMIT_REACHED' },
      { kind: 'not_found' },
      { kind: 'unknown' },
    ]) {
      expect(RewardStatus.safeParse(ok).success).toBe(true);
    }
    expect(RewardStatus.safeParse({ kind: 'failed' }).success).toBe(false);
    expect(RewardStatus.safeParse({ kind: 'issued', reference: 'x' }).success).toBe(false);
  });

  it('INV-PORT-REQUEST: a reward request is integer minor units and nothing else', () => {
    const ok = {
      external_player_id: 'pl-1',
      reward: { type: 'bonus', amount_minor: 500, currency: 'EUR' },
      sandbox: false,
    };
    expect(RewardRequest.safeParse(ok).success).toBe(true);
    expect(
      RewardRequest.safeParse({ ...ok, reward: { ...ok.reward, amount_minor: 5.5 } }).success,
    ).toBe(false);
    expect(RewardRequest.safeParse({ ...ok, idempotency_key: 'k' }).success).toBe(false); // key travels beside it
  });

  // D-12. Mutation: give `sandbox` a default (or make it optional): a caller that forgets it
  // silently sends a sandbox order to the production casino.
  it('INV-PORT-SANDBOX-FLAG: the request carries a mandatory sandbox flag', () => {
    const base = {
      external_player_id: 'pl-1',
      reward: { type: 'bonus', amount_minor: 500, currency: 'EUR' },
    };
    expect(RewardRequest.safeParse(base).success).toBe(false);
    expect(RewardRequest.safeParse({ ...base, sandbox: 'false' }).success).toBe(false);
    expect(RewardRequest.safeParse({ ...base, sandbox: true }).success).toBe(true);
  });

  // D-12. Mutation: drop a bound, make the deadline optional, or add a recovery mode.
  it('INV-PORT-RESOLVED-INFO: a resolved port declares its recovery mode, an issue deadline in bounds, and its environment', () => {
    expect([...RECOVERY_MODES]).toEqual(['native_lookup', 'idempotent_replay']);
    expect([ISSUE_DEADLINE_MS_MIN, ISSUE_DEADLINE_MS_MAX]).toEqual([60_000, 604_800_000]);
    const ok = { recovery_mode: 'native_lookup', issue_deadline_ms: 900_000, sandbox: false };
    expect(ResolvedPortInfo.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, issue_deadline_ms: 59_999 },
      { ...ok, issue_deadline_ms: 604_800_001 },
      { ...ok, issue_deadline_ms: 1.5 * 60_000 + 0.5 },
      { recovery_mode: ok.recovery_mode, sandbox: false }, // no deadline
      { ...ok, recovery_mode: 'magic' },
      { ...ok, sandbox: undefined },
    ]) {
      expect(ResolvedPortInfo.safeParse(bad).success).toBe(false);
    }
  });

  // D-12. Mutation: give sandbox_base_url a default of base_url, or drop .strict().
  it('INV-PORT-TENANT-CONFIG: per tenant reward API settings; the sandbox endpoint is its own field, never derived', () => {
    const prod = { base_url: 'https://casino.example/api' };
    expect(CasinoRewardApiConfig.safeParse(prod).success).toBe(true);
    expect(CasinoRewardApiConfig.parse(prod).sandbox_base_url).toBeUndefined();
    expect(
      CasinoRewardApiConfig.safeParse({
        ...prod,
        sandbox_base_url: 'https://sandbox.casino.example/api',
        sandbox_api_key: 'k',
        issue_deadline_ms: 120_000,
      }).success,
    ).toBe(true);
    expect(CasinoRewardApiConfig.safeParse({ base_url: 'not a url' }).success).toBe(false);
    expect(CasinoRewardApiConfig.safeParse({ ...prod, issue_deadline_ms: 5 }).success).toBe(false);
    expect(CasinoRewardApiConfig.safeParse({ ...prod, extra: 1 }).success).toBe(false);
  });
});

describe('spin.completed (D-1: payments credits coins from this event)', () => {
  it('INV-SPIN-EVENT-CONTRACT: carries spin_id, player_id, reward_coins and the REQUIRED table_version (X-16)', () => {
    const base = { spin_id: SPIN, player_id: USER, reward_coins: 25 };
    const payload = { ...base, table_version: 6 };
    const ev = parseEvent(createEvent({ type: 'engagement.spin.completed', tenantId: T, payload }));
    expect(ev.payload).toEqual(payload);
    // X-16: a spin without its table version cannot be audited; it is not an event.
    expect(() =>
      createEvent({ type: 'engagement.spin.completed', tenantId: T, payload: base as never }),
    ).toThrow();
    expect(() =>
      parseEvent(
        createEvent({
          type: 'engagement.spin.completed',
          tenantId: T,
          payload: { ...base, table_version: 0 },
        } as never),
      ),
    ).toThrow();
  });
});
