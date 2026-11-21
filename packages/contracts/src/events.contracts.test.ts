import { createEvent, InvalidEventError, parseEvent, uuidv7, Uuidv7 } from './index';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

describe('uuidv7', () => {
  it('produces valid, time-ordered ids', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(Uuidv7.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
  });

  it('rejects a v4 uuid', () => {
    expect(Uuidv7.safeParse('0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b').success).toBe(false);
  });
});

// F3 / X-3 / D-13. Mutation: drop `sandbox` from EventEnvelope or from createEvent.
describe('event envelope: sandbox flag (D-13)', () => {
  const input = {
    type: 'identity.tenant.created',
    tenantId: TENANT,
    payload: { name: 'A', slug: 'a' },
  } as const;

  it('INV-ENV-SANDBOX: the producer can mark an envelope sandbox; absent means production', () => {
    const sandboxOf = (e: object) => (e as { sandbox?: boolean }).sandbox;
    expect(sandboxOf(createEvent({ ...input, sandbox: true } as never))).toBe(true);
    expect(sandboxOf(createEvent(input))).toBeUndefined();
  });

  it('INV-ENV-SANDBOX-TYPED: a non-boolean sandbox is not an envelope', () => {
    const e = createEvent({ ...input, sandbox: true } as never);
    expect(() => parseEvent({ ...e, sandbox: 'yes' })).toThrow(InvalidEventError);
  });
});

describe('event envelope', () => {
  it('createEvent builds an envelope with all required fields', () => {
    const e = createEvent({
      type: 'identity.tenant.created',
      tenantId: TENANT,
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(Object.keys(e).sort()).toEqual(
      [
        'causation_id',
        'correlation_id',
        'event_id',
        'occurred_at',
        'payload',
        'tenant_id',
        'type',
        'version',
      ].sort(),
    );
    expect(e.tenant_id).toBe(TENANT);
    expect(e.causation_id).toBeNull();
  });

  it('rejects an event without a tenant', () => {
    const e = createEvent({
      type: 'identity.tenant.created',
      tenantId: TENANT,
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(() => parseEvent({ ...e, tenant_id: undefined })).toThrow(InvalidEventError);
  });

  it('rejects an unknown type and an unknown version', () => {
    const e = createEvent({
      type: 'identity.tenant.created',
      tenantId: TENANT,
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(() => parseEvent({ ...e, type: 'nope.nope.nope' })).toThrow(/unknown event/);
    expect(() => parseEvent({ ...e, version: 2 })).toThrow(/unknown event/);
  });

  it('rejects a payload that does not match the registered schema', () => {
    const e = createEvent({
      type: 'identity.tenant.created',
      tenantId: TENANT,
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(() => parseEvent({ ...e, payload: { name: '' } })).toThrow(/invalid payload/);
  });
});
