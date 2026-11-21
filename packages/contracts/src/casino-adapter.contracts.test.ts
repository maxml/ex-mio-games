import { IssueResult, RewardRequest, RewardStatus, createEvent, parseEvent } from './index';

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
    };
    expect(RewardRequest.safeParse(ok).success).toBe(true);
    expect(
      RewardRequest.safeParse({ ...ok, reward: { ...ok.reward, amount_minor: 5.5 } }).success,
    ).toBe(false);
    expect(RewardRequest.safeParse({ ...ok, idempotency_key: 'k' }).success).toBe(false); // key travels beside it
  });
});

describe('spin.completed (D-1: payments credits coins from this event)', () => {
  it('INV-SPIN-EVENT-CONTRACT: carries spin_id, player_id, reward_coins and the optional table_version', () => {
    const base = { spin_id: SPIN, player_id: USER, reward_coins: 25 };
    for (const payload of [base, { ...base, table_version: 6 }]) {
      const ev = parseEvent(
        createEvent({ type: 'engagement.spin.completed', tenantId: T, payload }),
      );
      expect(ev.payload).toEqual(payload);
    }
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
