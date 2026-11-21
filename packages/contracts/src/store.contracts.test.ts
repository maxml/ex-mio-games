import {
  CreateRedemptionRequest,
  PUBLIC_STATUS_OF,
  REDEMPTION_STATUSES,
  createEvent,
  parseEvent,
} from './index';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const RID = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';

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

  it('hold commands and events are registered and validated', () => {
    const cmd = createEvent({
      type: 'engagement.hold.place',
      tenantId: TENANT,
      payload: {
        operation_id: `hold:${RID}`,
        redemption_id: RID,
        player_id: 'p1',
        sandbox: false,
        amount: 5,
      },
    });
    expect(parseEvent(cmd).type).toBe('engagement.hold.place');
    expect(() =>
      parseEvent({ ...cmd, payload: { ...(cmd.payload as object), amount: 0 } }),
    ).toThrow();
    expect(() =>
      createEvent({
        type: 'payments.hold.command_rejected',
        tenantId: TENANT,
        payload: {
          redemption_id: RID,
          player_id: 'p1',
          sandbox: false,
          command: 'capture',
          reason: 'hold_already_released',
        },
      }),
    ).not.toThrow();
  });
});
