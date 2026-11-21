import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CreateRedemptionRequest,
  EVENT_SCHEMAS,
  PUBLIC_STATUS_OF,
  REDEMPTION_STATUSES,
  STORE_ERROR_CODES,
  createEvent,
  parseEvent,
} from './index';
import type * as Contracts from './index';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const RID = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const P1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01';

// Pins the store contracts (docs/specs/engagement-store.md §6).
// Mutation: drop a status from PUBLIC_STATUS_OF, or loosen `.strict()` on the
// create request, or remove an event from EVENT_SCHEMAS: the matching test goes red.
describe('store contracts', () => {
  it('every redemption state maps to a public status', () => {
    for (const s of REDEMPTION_STATUSES) expect(PUBLIC_STATUS_OF[s]).toBeDefined();
    expect(PUBLIC_STATUS_OF.NEEDS_REVIEW).toBe('pending');
    expect(PUBLIC_STATUS_OF.RELEASED).toBe('failed_refunded');
  });

  it('a redemption request cannot carry a sandbox flag or a price', () => {
    expect(CreateRedemptionRequest.safeParse({ item_id: RID }).success).toBe(true);
    expect(CreateRedemptionRequest.safeParse({ item_id: RID, sandbox: true }).success).toBe(false);
    expect(CreateRedemptionRequest.safeParse({ item_id: RID, price: 1 }).success).toBe(false);
  });

  it('the redemption events are registered and validated', () => {
    const ev = createEvent({
      type: 'engagement.redemption.status_changed',
      tenantId: TENANT,
      payload: {
        redemption_id: RID,
        player_id: P1,
        sandbox: false,
        from: null,
        to: 'REQUESTED',
        cause: 'order_placed',
      },
    });
    expect(parseEvent(ev).type).toBe('engagement.redemption.status_changed');
    expect(() =>
      parseEvent({ ...ev, payload: { ...(ev.payload as object), to: 'NOT_A_STATE' } }),
    ).toThrow();
    for (const t of ['issued', 'rejected', 'needs_review'])
      expect(Object.keys(EVENT_SCHEMAS)).toContain(`engagement.redemption.${t}`);
  });

  // D-1/D-9: payments owns the coin reserve (a synchronous internal API); the store defines no
  // hold command and no hold event, and adopts none of the payments events as its own.
  // Mutation: re-register `engagement.hold.*` or `payments.hold.*` in EVENT_SCHEMAS -> red.
  it('D-1: no engagement.hold.* command and no payments.hold.* event is registered', () => {
    const bad = Object.keys(EVENT_SCHEMAS).filter(
      (t) => t.startsWith('engagement.hold.') || t.startsWith('payments.hold.'),
    );
    expect(bad).toEqual([]);
  });

  // D-2: ONE adapter port, in casino-adapter.ts.
  // Mutation: define a port (or any of its old type names) again in store.ts -> red.
  it('D-2: the casino port is defined once; store.ts exports none of its types', () => {
    const src = readFileSync(join(__dirname, 'store.ts'), 'utf8');
    for (const name of [
      'RewardAdapter',
      'IssueRewardRequest',
      'IssueRewardResult',
      'RewardStatusResult',
      'CasinoRewardPort',
      'IssueResult',
      'RewardStatus',
    ])
      expect(src).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  // Type-level pin, checked by `tsc` (ts-jest runs with isolatedModules and erases it):
  // the store's own adapter type no longer resolves.
  it('D-2: the old RewardAdapter type is gone from the package index', () => {
    // @ts-expect-error RewardAdapter was the store's own port; only CasinoRewardPort exists now
    type Old = Contracts.RewardAdapter;
    const unused: Old | null = null;
    expect(unused).toBeNull();
  });

  it('D-8: insufficient_funds is a store error code and the gate refusal has its own code', () => {
    expect(STORE_ERROR_CODES.insufficient_funds).toBe(409);
    expect(STORE_ERROR_CODES.release_not_allowed).toBe(409);
  });
});
