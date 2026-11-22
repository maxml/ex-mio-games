import {
  createEvent,
  ErrorBody,
  EVENT_SCHEMAS,
  InvalidEventError,
  parseEvent,
  uuidv7,
  Uuidv7,
} from './index';

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

// FX-2. Mutation: remove `code` from ErrorBody (zod strips it, so a service's code is lost).
describe('ErrorBody', () => {
  it('keeps an optional machine-readable code', () => {
    expect(ErrorBody.parse({ message: 'm', code: 'out_of_stock' }).code).toBe('out_of_stock');
    expect(ErrorBody.parse({ message: 'm' }).code).toBeUndefined();
  });
});

// F3 / X-3 / D-13. Mutation: drop `sandbox` from EventEnvelope or from createEvent.
describe('event envelope: sandbox flag (D-13)', () => {
  const input = {
    type: 'identity.tenant.created',
    tenantId: TENANT,
    payload: { name: 'A', slug: 'a' },
  } as const;

  it('INV-ENV-SANDBOX: the producer states the environment of an envelope; it is never absent (D-29)', () => {
    const sandboxOf = (e: object) => (e as { sandbox?: boolean }).sandbox;
    expect(sandboxOf(createEvent({ ...input, sandbox: true }))).toBe(true);
    expect(sandboxOf(createEvent({ ...input, sandbox: false }))).toBe(false);
  });

  it('INV-ENV-SANDBOX-TYPED: a non-boolean sandbox is not an envelope', () => {
    const e = createEvent({ ...input, sandbox: true });
    expect(() => parseEvent({ ...e, sandbox: 'yes' })).toThrow(InvalidEventError);
  });
});

describe('event envelope', () => {
  it('createEvent builds an envelope with all required fields', () => {
    const e = createEvent({
      type: 'identity.tenant.created',
      tenantId: TENANT,
      sandbox: false,
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(Object.keys(e).sort()).toEqual(
      [
        'causation_id',
        'correlation_id',
        'event_id',
        'occurred_at',
        'payload',
        'sandbox',
        'tenant_id',
        'type',
        'version',
      ].sort(),
    );
    expect(e.tenant_id).toBe(TENANT);
    expect(e.causation_id).toBeNull();
  });

  // FX-1/D-13. Mutation: drop `sandbox` from EventEnvelope (zod strips it) or write it when false.
  it('FX-1: createEvent always writes sandbox (false for production); parseEvent keeps it', () => {
    const base = {
      type: 'identity.tenant.created',
      tenantId: TENANT,
      payload: { name: 'A', slug: 'ab' },
    } as const;
    const prod = createEvent({ ...base, sandbox: false });
    expect(prod.sandbox).toBe(false);
    const sbx = createEvent({ ...base, sandbox: true });
    expect(sbx.sandbox).toBe(true);
    expect(parseEvent(JSON.parse(JSON.stringify(sbx))).sandbox).toBe(true);
    expect(parseEvent(prod).sandbox).toBe(false);
    expect(() => parseEvent({ ...prod, sandbox: 'yes' })).toThrow(InvalidEventError);
  });

  // X-13. Mutation: put `sandbox` back into a redemption event payload schema.
  it('X-13: no event payload schema carries its own sandbox flag (the envelope is the only place)', () => {
    for (const versions of Object.values(EVENT_SCHEMAS)) {
      for (const schema of Object.values(versions)) {
        const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape) expect(Object.keys(shape)).not.toContain('sandbox');
      }
    }
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
