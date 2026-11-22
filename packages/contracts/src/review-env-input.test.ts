import { createEvent, EventEnvelope } from './events';
import { IssueCredentialRequest, PutRewardApiRequest } from './identity';
import { scopedKey } from './scoped-key';

/*
 * D-29 INV-ENV-INPUT (docs/specs/env-input.md section 4), the contract choke points.
 *
 * INV-ENV-INPUT-1: the environment of a per-environment operator resource is required.
 *   Spec #1 (F12) IssueCredentialRequest, #2 (F7) PutRewardApiRequest. Mutation: add
 *   `.default('production')` back to either -> red. (The internal balance query, #3 / F9, lives in
 *   payments: its `.default('false')` is caught by INV-ENV-INPUT-2a, the static scan.)
 * INV-ENV-INPUT-5: the envelope's `sandbox` is a required boolean (spec #11, N-4). Mutation:
 *   restore `sandbox: z.boolean().optional()` or the "write only when true" spread -> red.
 * INV-ENV-INPUT-8 (green, a pin): scopedKey keeps its required flag. Mutation (re-applied in the
 *   review): `sandbox: boolean` read as `sandbox ?? false` with the type check removed -> red.
 */

const T = '0190a1b2-c3d4-7e5f-8a6b-000000000001';

describe('INV-ENV-INPUT-1 the environment is required where an operator names it (spec 3.1)', () => {
  it('INV-ENV-INPUT-1a IssueCredentialRequest without environment is refused', () => {
    expect(IssueCredentialRequest.safeParse({ platform: 'sim-casino' }).success).toBe(false);
    expect(
      IssueCredentialRequest.safeParse({ platform: 'sim-casino', environment: 'sandbox' }).success,
    ).toBe(true);
  });

  it('INV-ENV-INPUT-1b PutRewardApiRequest without environment is refused', () => {
    const base_url = 'https://rewards.casino.example/v1';
    expect(PutRewardApiRequest.safeParse({ base_url }).success).toBe(false);
    expect(PutRewardApiRequest.safeParse({ base_url, environment: 'production' }).success).toBe(
      true,
    );
  });
});

describe('INV-ENV-INPUT-5 the event envelope requires sandbox (spec 3.1, #11)', () => {
  it('INV-ENV-INPUT-5a createEvent without sandbox throws', () => {
    expect(() =>
      createEvent({
        type: 'engagement.spin.completed',
        tenantId: T,
        payload: { spin_id: T, player_id: T, reward_coins: 0, table_version: 1 },
      } as never),
    ).toThrow();
  });

  it('INV-ENV-INPUT-5b createEvent writes sandbox:false for production (never absent)', () => {
    const e = createEvent({
      type: 'engagement.spin.completed',
      tenantId: T,
      sandbox: false,
      payload: { spin_id: T, player_id: T, reward_coins: 0, table_version: 1 },
    } as never) as { sandbox?: unknown };
    expect(e.sandbox).toBe(false);
  });

  it('INV-ENV-INPUT-5c a consumer refuses an envelope without sandbox', () => {
    const withFlag = createEvent({
      type: 'engagement.spin.completed',
      tenantId: T,
      sandbox: true,
      payload: { spin_id: T, player_id: T, reward_coins: 0, table_version: 1 },
    } as never) as Record<string, unknown>;
    expect(EventEnvelope.safeParse(withFlag).success).toBe(true);
    const { sandbox: _dropped, ...without } = withFlag;
    expect(EventEnvelope.safeParse(without).success).toBe(false);
  });
});

describe('INV-ENV-INPUT-8 scopedKey keeps the environment required (spec 3.3)', () => {
  it('INV-ENV-INPUT-8 the two environments give different keys and a missing flag throws', () => {
    const k = (sandbox: unknown) =>
      scopedKey({ kind: 'order', tenantId: T, sandbox: sandbox as boolean, parts: ['k1'] });
    expect(k(true)).not.toBe(k(false));
    expect(() => k(undefined)).toThrow();
    expect(() => k('false')).toThrow();
  });
});
