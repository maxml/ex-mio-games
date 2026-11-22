import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { ProductEventLine } from '@ex-mio/contracts';
import { createLogger } from './logger';
import {
  actorFromAuth,
  emitProductEvent,
  logProductEvent,
  setProductEventLogger,
} from './product-event';

const SCHEMA_DIR = join(__dirname, '../../contracts/schemas');
const schemaText = readFileSync(join(SCHEMA_DIR, 'varta-product-event.schema.json'), 'utf8');
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(schemaText));

const TENANT = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const ACTOR = '0190a1b2-c3d4-7e5f-8a6b-000000000001';

function capture() {
  const chunks: string[] = [];
  const logger = createLogger(
    { name: 'test-svc', level: 'info' },
    { write: (s) => void chunks.push(s) },
  );
  return {
    logger,
    raw: () => chunks,
    lines: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

const base = {
  event: 'engagement.spin_completed',
  tenant_id: TENANT,
  actor_type: 'player',
  actor_id: ACTOR,
};

describe('vendored Varta schema', () => {
  it('records its source commit and matches the recorded hash', () => {
    const source = readFileSync(join(SCHEMA_DIR, 'varta-product-event.schema.SOURCE'), 'utf8');
    expect(source).toMatch(/^commit: [0-9a-f]{40}$/m);
    const sha = /^sha256: ([0-9a-f]{64})$/m.exec(source)?.[1];
    expect(createHash('sha256').update(schemaText).digest('hex')).toBe(sha);
  });
});

describe('logProductEvent conforms to the Varta schema (D-19)', () => {
  const good: Array<[string, Record<string, unknown>]> = [
    ['a known actor', base],
    [
      'props',
      { ...base, props: { reward_coins: 5, sandbox: false, currency: 'EUR', casino: 'casino_a' } },
    ],
    ['an anonymous actor', { ...base, actor_id: undefined, anon_id: 'a-7.b' }],
    [
      'all optional fields',
      { ...base, session_id: 's-9', consent: 'analytics', actor_since: '2026-03-14', event_v: 2 },
    ],
    ['a PII-named boolean flag', { ...base, props: { has_email: true } }],
    ['a text that only starts with a bracket', { ...base, props: { note: '[Draft] title' } }],
  ];
  it.each(good)('emits a conforming line for %s', (_name, input) => {
    const { logger, raw, lines } = capture();
    logProductEvent(logger, input as never);
    expect(raw()).toHaveLength(1);
    const [line] = lines();
    expect(validate(line)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(ProductEventLine.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({ kind: 'product_event', level: 'info', service: 'test-svc' });
    expect(line?.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Buffer.byteLength(raw()[0] as string)).toBeLessThanOrEqual(8192);
  });

  // VAR-6: the collector drops every top-level key off its allowlist and silently strips pino's
  // pid, hostname, time and msg. So the line is a closed envelope: exactly the schema keys we set,
  // plus the three identity fields the logger is configured to add.
  it('writes a closed envelope: no msg, pid, hostname or time, no key off the schema', () => {
    const { logger, lines } = capture();
    logProductEvent(logger, {
      ...base,
      session_id: 's-1',
      consent: 'analytics',
      actor_since: '2026-03-14',
      props: { reward_coins: 5 },
    });
    const keys = Object.keys(lines()[0] as object).sort();
    expect(keys).toEqual(
      [
        'ts',
        'level',
        'service',
        'env',
        'version',
        'kind',
        'event',
        'event_v',
        'event_id',
        'tenant_id',
        'actor_type',
        'actor_id',
        'session_id',
        'consent',
        'actor_since',
        'props',
      ].sort(),
    );
    const schemaKeys = Object.keys(JSON.parse(schemaText).properties);
    for (const k of keys) expect(schemaKeys).toContain(k);
    for (const stripped of ['msg', 'pid', 'hostname', 'time']) expect(keys).not.toContain(stripped);
  });

  it('writes a fresh lower-case UUIDv7 event_id per event', () => {
    const { logger, lines } = capture();
    logProductEvent(logger, base);
    logProductEvent(logger, base);
    const [a, b] = lines().map((l) => l.event_id);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('defaults consent to essential and event_v to 1', () => {
    const { logger, lines } = capture();
    logProductEvent(logger, base);
    expect(lines()[0]).toMatchObject({ consent: 'essential', event_v: 1 });
  });

  // One negative per D-19 rule. The same mutation, applied to a valid line, must fail the Varta
  // schema AND the contract's zod check, and logProductEvent must refuse it before writing.
  const bad: Array<[string, Record<string, unknown>]> = [
    ['no tenant', { ...base, tenant_id: undefined }],
    ['a tenant of 49 chars', { ...base, tenant_id: 'x'.repeat(49) }],
    ['a tenant with @', { ...base, tenant_id: 'a@b' }],
    ['an event name without a domain', { ...base, event: 'spin_completed' }],
    ['an upper-case event name', { ...base, event: 'Engagement.spin' }],
    ['event_v 0', { ...base, event_v: 0 }],
    ['both actor_id and anon_id', { ...base, anon_id: 'a-1' }],
    ['neither actor_id nor anon_id', { ...base, actor_id: undefined }],
    ['an actor_id starting with anon:', { ...base, actor_id: 'ANON:x' }],
    ['an actor_id of 97 chars', { ...base, actor_id: 'x'.repeat(97) }],
    ['an email as actor_id', { ...base, actor_id: 'a@b.co' }],
    ['an anon_id of 92 chars', { ...base, actor_id: undefined, anon_id: 'x'.repeat(92) }],
    ['an actor_type in upper case', { ...base, actor_type: 'Player' }],
    ['an unknown consent', { ...base, consent: 'yes' }],
    ['a bad actor_since', { ...base, actor_since: '14/03/2026' }],
    ['a stray top-level key', { ...base, player_id: ACTOR }],
    ['an email prop key', { ...base, props: { email: 'x' } }],
    ['a PII suffix prop key', { ...base, props: { player_email: 'x' } }],
    ['a varta_ prop key', { ...base, props: { varta_x: 1 } }],
    ['an upper-case prop key', { ...base, props: { Coins: 1 } }],
    ['a nested prop', { ...base, props: { a: { b: 1 } } }],
    ['an array prop', { ...base, props: { a: [1] } }],
    ['an email prop value', { ...base, props: { contact: 'p@example.com' } }],
    ['a JSON text prop value', { ...base, props: { blob: '{"a":1}' } }],
    ['a non-boolean PII flag', { ...base, props: { has_email: 'yes' } }],
  ];
  it.each(bad)('refuses %s', (_name, input) => {
    const { logger, raw } = capture();
    expect(() => logProductEvent(logger, input as never)).toThrow();
    expect(raw()).toHaveLength(0);
    const line = {
      ts: '2026-11-21T10:11:12.345Z',
      level: 'info',
      kind: 'product_event',
      event_id: '01a1fd96-ab59-701a-901b-000000000001',
      event_v: 1,
      consent: 'essential',
      ...input,
    };
    expect(validate(JSON.parse(JSON.stringify(line)))).toBe(false);
    expect(ProductEventLine.safeParse(line).success).toBe(false);
  });

  it('refuses a line that could pass 8 KiB', () => {
    const { logger, raw } = capture();
    const props = Object.fromEntries(
      Array.from({ length: 70 }, (_v, i) => [`k${i}`, 'x'.repeat(120)]),
    );
    expect(() => logProductEvent(logger, { ...base, props })).toThrow(/8 KiB/);
    expect(raw()).toHaveLength(0);
  });

  it('rejects a default pino line (numeric level, no ts) in the schema', () => {
    expect(
      validate({
        level: 30,
        time: 1,
        kind: 'product_event',
        ...base,
        event_v: 1,
        consent: 'essential',
      }),
    ).toBe(false);
  });
});

describe('emitProductEvent', () => {
  afterEach(() => setProductEventLogger(undefined));

  it('never throws on a bad event: it drops it and warns', () => {
    const { logger, lines } = capture();
    setProductEventLogger(logger);
    expect(() => emitProductEvent({ ...base, props: { email: 'x' } })).not.toThrow();
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'warn', msg: 'product_event_dropped' });
    expect(out[0]).not.toHaveProperty('kind');
  });

  it('takes actor and tenant from the auth context', () => {
    expect(
      actorFromAuth({ mode: 'user', tenantId: TENANT, principalId: ACTOR, roles: ['player'] }),
    ).toEqual({ tenant_id: TENANT, actor_type: 'player', actor_id: ACTOR });
    expect(
      actorFromAuth({
        mode: 'user',
        tenantId: 'platform',
        principalId: ACTOR,
        roles: ['platform_admin'],
        acting: { tenantId: TENANT },
      }),
    ).toMatchObject({ tenant_id: TENANT, actor_type: 'platform_admin' });
    expect(
      actorFromAuth({
        mode: 'service',
        tenantId: TENANT,
        principalId: 'x',
        roles: [],
        service: 'engagement',
      }),
    ).toMatchObject({ actor_type: 'service', actor_id: 'engagement' });
  });
});
