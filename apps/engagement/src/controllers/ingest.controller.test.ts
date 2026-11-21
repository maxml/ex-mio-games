import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IngestAck, IngestErrorBody, parseEvent, type EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { authModule } from '../testing/auth.fixture'; // RED: depends on ServiceAuthModule (identity epic)
import { createDefaultRegistry } from '../integrations/registry'; // RED: module missing
import {
  ADAPTER_REGISTRY,
  CLOCK,
  InboundEventsRepository,
  PLAYER_DIRECTORY,
  TENANT_INTEGRATIONS,
  type InboundEventRow,
  type TenantIntegration,
} from '../integrations/ports';
import { IngestController, registerRawJsonParser } from './ingest.controller'; // RED: missing
import { IngestionService } from '../services/ingestion.service'; // RED: missing

/**
 * Ingestion endpoint POST /v1/integrations/:slug/events (MIO-054, MIO-055, MIO-056, MIO-147).
 * In-process: real controller, real IngestionService, real adapters; fake ports. The database-level
 * guarantee (UNIQUE) is pinned separately by tests/compose/src/ingest.compose.test.ts.
 *
 * Mutations (each turns the named tests red):
 *  - IngestionService: skip signature verification / compare to `true` -> INV-ING-SIG.
 *  - verify with the secrets of the body-named tenant instead of the slug's -> INV-ING-CROSS-TENANT.
 *  - publish even when `inserted === false` -> INV-ING-DEDUPE, INV-ING-DEDUPE-PARALLEL.
 *  - publish in a second tenantTx / without the insert's tx -> INV-ING-ATOMIC.
 *  - parse the body before verifying the signature -> INV-ING-SIG-FIRST.
 *  - try only the first secret -> INV-ING-ROTATION.
 *  - check `suspended` before the signature -> INV-ING-SUSPENDED.
 *  - store the raw external player id in the row, hash without the tenant key, or hash a different
 *    message than `${source}\n${external_player_id}` -> INV-ING-PLAYER-HMAC (D-12).
 *  - put external_player_id back into the event, resolve after the outbox write, or publish when
 *    identity is down                                       -> INV-ING-ACCEPT, INV-ING-IDENTITY-DOWN (X-1).
 *  - take `sandbox` from anything but the verified integration's environment -> INV-ING-SANDBOX (X-3).
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const T1 = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const T2 = '0190a1b2-c3d4-4e5f-8a6b-000000000002';
const T3 = '0190a1b2-c3d4-4e5f-8a6b-000000000003';
const T4 = '0190a1b2-c3d4-4e5f-8a6b-000000000004';
const T5 = '0190a1b2-c3d4-4e5f-8a6b-000000000005';
const hmac = (secret: string, msg: string) =>
  createHmac('sha256', secret).update(msg).digest('hex');
const HASH_KEYS = {
  acme: 'hk-acme',
  globex: 'hk-globex',
  bravo: 'hk-bravo',
  frozen: 'hk-frozen',
  sandboxed: 'hk-sandboxed',
};

// Independent signers (the oracle for each casino's wire protocol, docs/specs section 3).
function signedA(
  secret: string,
  o: { id?: string; amount?: unknown; ageS?: number; status?: string } = {},
) {
  const ts = Math.floor(NOW.getTime() / 1000) - (o.ageS ?? 0);
  const raw = JSON.stringify({
    eventId: o.id ?? 'evt-1',
    playerId: 'pl-1',
    amount: { value: o.amount ?? 5000, currency: 'EUR' },
    status: o.status ?? 'SUCCESS',
    ts,
  });
  return {
    raw,
    headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac(secret, `${ts}.${raw}`) },
  };
}
function signedB(secret: string, o: { id?: string } = {}) {
  const data = { txn_id: o.id ?? 'evt-1', customer_ref: 'pl-1', amount_cents: 5000, ccy: 'EUR' };
  const sent_at = NOW.toISOString();
  const signature = hmac(
    secret,
    `${sent_at}.payment.completed.${data.txn_id}.${data.customer_ref}.${data.amount_cents}.${data.ccy}`,
  );
  return {
    raw: JSON.stringify({ type: 'payment.completed', data, sent_at, signature }),
    headers: {},
  };
}

let integrations: Record<string, TenantIntegration>;
let identityDown = false;
/** What the fake identity directory was asked: [tenant, source, raw casino player id]. */
const resolved: Array<[string, string, string]> = [];
/** The internal player id identity would return: stable per (tenant, casino id), a uuid. */
const playerIdOf = (tenantId: string, externalPlayerId: string) =>
  `0190a1b2-c3d4-4e5f-8a6b-${hmac(tenantId, externalPlayerId).slice(0, 12)}`;
class FakeInbound extends InboundEventsRepository {
  rows = new Map<string, { id: string; row: InboundEventRow }>();
  async insertIfAbsent(_tx: unknown, row: InboundEventRow) {
    const key = `${row.tenantId}|${row.source}|${row.externalEventId}`;
    const existing = this.rows.get(key);
    if (existing) return { inserted: false, id: existing.id };
    const id = `0190a1b2-c3d4-4e5f-8a6b-${String(this.rows.size + 1).padStart(12, 'a')}`;
    this.rows.set(key, { id, row });
    return { inserted: true, id };
  }
}

describe('ingestion endpoint', () => {
  let app: NestFastifyApplication;
  let inbound: FakeInbound;
  let published: Array<{ tx: unknown; event: EventEnvelope }>;
  let txCalls: unknown[];
  let publishFails = false;

  const fakeDb = {
    // rolls the fake table back when the callback throws, like a real transaction
    async tenantTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = { id: txCalls.length + 1 };
      txCalls.push(tx);
      const before = new Map(inbound.rows);
      const pubBefore = published.length;
      try {
        return await fn(tx);
      } catch (err) {
        inbound.rows = before;
        published.length = pubBefore;
        throw err;
      }
    },
    async publish(tx: unknown, event: EventEnvelope) {
      if (publishFails) throw new Error('outbox down');
      published.push({ tx, event });
    },
  };

  beforeEach(async () => {
    inbound = new FakeInbound();
    published = [];
    txCalls = [];
    publishFails = false;
    identityDown = false;
    resolved.length = 0;
    // identity's TenantIntegration contract type (X-7): `platform` is the adapter registry key
    integrations = {
      acme: {
        tenant_id: T1,
        platform: 'casino-a',
        status: 'active',
        environment: 'production',
        webhook_secrets: ['sec-acme'],
        player_hash_key: HASH_KEYS.acme,
      },
      globex: {
        tenant_id: T2,
        platform: 'casino-a',
        status: 'active',
        environment: 'production',
        webhook_secrets: ['sec-globex'],
        player_hash_key: HASH_KEYS.globex,
      },
      bravo: {
        tenant_id: T3,
        platform: 'casino-b',
        status: 'active',
        environment: 'production',
        webhook_secrets: ['sec-bravo'],
        player_hash_key: HASH_KEYS.bravo,
      },
      frozen: {
        tenant_id: T4,
        platform: 'casino-a',
        status: 'suspended',
        environment: 'production',
        webhook_secrets: ['sec-frozen'],
        player_hash_key: HASH_KEYS.frozen,
      },
      sandboxed: {
        tenant_id: T5,
        platform: 'casino-a',
        status: 'active',
        environment: 'sandbox',
        webhook_secrets: ['sec-sbx'],
        player_hash_key: HASH_KEYS.sandboxed,
      },
    };
    const mod = await Test.createTestingModule({
      // the real entry point (D-4); the webhook route is @Public, so it needs no token
      imports: [authModule()],
      controllers: [IngestController],
      providers: [
        IngestionService,
        { provide: Db, useValue: fakeDb },
        { provide: InboundEventsRepository, useValue: inbound },
        {
          provide: TENANT_INTEGRATIONS,
          useValue: { lookup: async (s: string) => integrations[s] },
        },
        // X-1: identity is the only writer of the player link; ingest resolves BEFORE the outbox write
        {
          provide: PLAYER_DIRECTORY,
          useValue: {
            resolveOrCreate: async (tenantId: string, source: string, externalPlayerId: string) => {
              if (identityDown) throw new Error('identity unreachable');
              resolved.push([tenantId, source, externalPlayerId]);
              return playerIdOf(tenantId, externalPlayerId);
            },
          },
        },
        { provide: ADAPTER_REGISTRY, useValue: createDefaultRegistry() },
        { provide: CLOCK, useValue: { now: () => NOW } },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerRawJsonParser(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(() => app.close());

  const post = (slug: string, built: { raw: string; headers: Record<string, string> }) =>
    app.inject({
      method: 'POST',
      url: `/v1/integrations/${slug}/events`,
      headers: { 'content-type': 'application/json', ...built.headers },
      payload: built.raw,
    });
  const nothingHappened = () => {
    expect(inbound.rows.size).toBe(0);
    expect(published).toHaveLength(0);
  };
  // [slug, signer] pairs: every case below runs for each casino.
  const casinos = [
    [
      'acme',
      'sec-acme',
      (s: string, o?: object) => signedA(s, o),
      (b: { raw: string; headers: Record<string, string> }) => ({
        raw: b.raw,
        headers: { ...b.headers, 'x-a-signature': 'zz' },
      }),
    ],
    [
      'bravo',
      'sec-bravo',
      (s: string) => signedB(s),
      (b: { raw: string; headers: Record<string, string> }) => ({
        raw: b.raw.replace(/"signature":"[0-9a-f]+"/, '"signature":"zz"'),
        headers: b.headers,
      }),
    ],
  ] as const;

  describe.each(casinos)('tenant %s', (slug, secret, sign, garble) => {
    it('INV-ING-SIG: missing, wrong and malformed signatures are 401, no row, no event', async () => {
      const ok = sign(secret);
      const noSig =
        slug === 'acme'
          ? { raw: ok.raw, headers: {} }
          : { raw: ok.raw.replace(/,"signature":"[0-9a-f]+"/, ''), headers: {} };
      const res = await post(slug, noSig);
      expect(res.statusCode).toBe(401);
      expect(IngestErrorBody.parse(res.json()).code).toMatch(/^signature_(missing|invalid)$/);
      const wrong = await post(slug, sign('not-the-secret'));
      expect(wrong.statusCode).toBe(401);
      expect(IngestErrorBody.parse(wrong.json()).code).toBe('signature_invalid');
      const garbage = await post(slug, garble(ok));
      expect(garbage.statusCode).toBe(401);
      nothingHappened();
    });

    it("INV-ING-CROSS-TENANT: another tenant's valid secret is rejected", async () => {
      const res = await post(slug, sign('sec-globex'));
      expect(res.statusCode).toBe(401);
      expect(IngestErrorBody.parse(res.json()).code).toBe('signature_invalid');
      nothingHappened();
    });

    it('a valid event is accepted once: 200, a row, one deposit.confirmed in the same tx', async () => {
      const res = await post(slug, sign(secret));
      expect(res.statusCode).toBe(200);
      const ack = IngestAck.parse(res.json());
      expect(ack.status).toBe('accepted');
      expect(published).toHaveLength(1);
      const event = parseEvent(published[0]!.event);
      expect(event.type).toBe('engagement.deposit.confirmed');
      expect(event.tenant_id).toBe(integrations[slug]!.tenant_id);
      // X-1/D-12: the event carries the INTERNAL player id only (resolved through identity before
      // the outbox write); the raw casino id is nowhere in it. Mutation: put external_player_id back.
      expect(event.payload).toEqual({
        inbound_event_id: ack.inbound_event_id,
        source: slug === 'acme' ? 'casino-a' : 'casino-b',
        external_event_id: 'evt-1',
        player_id: playerIdOf(integrations[slug]!.tenant_id, 'pl-1'),
        amount_minor: 5000,
        currency: 'EUR',
        occurred_at: expect.any(String),
      });
      expect(JSON.stringify(published[0]!.event)).not.toContain('pl-1');
    });
  });

  it('INV-ING-STALE: 301 s old is 401 `stale`, 299 s old is accepted; nothing written when stale', async () => {
    const stale = await post('acme', signedA('sec-acme', { ageS: 301 }));
    expect(stale.statusCode).toBe(401);
    expect(IngestErrorBody.parse(stale.json()).code).toBe('stale');
    nothingHappened();
    const fresh = await post('acme', signedA('sec-acme', { ageS: 299 }));
    expect(fresh.statusCode).toBe(200);
  });

  it('INV-ING-SIG-FIRST: an unsigned body is 401 whatever it contains (no 400/422 oracle for strangers)', async () => {
    for (const raw of ['{not json', '{"amount":{"value":1.5}}', '']) {
      const res = await post('acme', { raw, headers: {} });
      expect(res.statusCode).toBe(401);
    }
    nothingHappened();
  });

  it('INV-ING-VALIDATION: signed but malformed JSON is 400; schema-invalid and float amount are 422', async () => {
    const ts = Math.floor(NOW.getTime() / 1000);
    const bad = '{not json';
    const malformed = await post('acme', {
      raw: bad,
      headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac('sec-acme', `${ts}.${bad}`) },
    });
    expect(malformed.statusCode).toBe(400);
    expect(IngestErrorBody.parse(malformed.json()).code).toBe('malformed_json');
    const float = await post('acme', signedA('sec-acme', { amount: 10.5 }));
    expect(float.statusCode).toBe(422);
    expect(IngestErrorBody.parse(float.json()).code).toBe('schema_invalid');
    const empty = '{"x":1}';
    const schema = await post('acme', {
      raw: empty,
      headers: { 'x-a-timestamp': String(ts), 'x-a-signature': hmac('sec-acme', `${ts}.${empty}`) },
    });
    expect(schema.statusCode).toBe(422);
    nothingHappened();
  });

  it('INV-ING-TENANT-LOOKUP: unknown slug is 404; a suspended tenant is 402 only for a valid signature', async () => {
    const unknown = await post('nobody', signedA('x'));
    expect(unknown.statusCode).toBe(404);
    expect(IngestErrorBody.parse(unknown.json()).code).toBe('unknown_tenant');
    const strangers = await post('frozen', signedA('wrong'));
    expect(strangers.statusCode).toBe(401); // INV-ING-SUSPENDED: status is not leaked unauthenticated
    const suspended = await post('frozen', signedA('sec-frozen'));
    expect(suspended.statusCode).toBe(402);
    expect(IngestErrorBody.parse(suspended.json()).code).toBe('tenant_suspended');
    nothingHappened();
  });

  it('INV-ING-IGNORED: an unsuccessful deposit is 200 ignored, no row, no event', async () => {
    const res = await post('acme', signedA('sec-acme', { status: 'FAILED' }));
    expect(res.statusCode).toBe(200);
    expect(IngestAck.parse(res.json())).toEqual({ status: 'ignored', inbound_event_id: null });
    nothingHappened();
  });

  it('INV-ING-DEDUPE: a duplicate is 200 with the first body, no second row, no second event', async () => {
    const first = await post('acme', signedA('sec-acme'));
    const second = await post('acme', signedA('sec-acme'));
    const third = await post('acme', signedA('sec-acme'));
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
    expect(second.json()).toEqual(first.json());
    expect(third.json()).toEqual(first.json());
    expect(inbound.rows.size).toBe(1);
    expect(published).toHaveLength(1);
  });

  it('INV-ING-DEDUPE-PARALLEL: 20 parallel deliveries produce one row and one event, all 200', async () => {
    const built = signedA('sec-acme');
    const all = await Promise.all(Array.from({ length: 20 }, () => post('acme', built)));
    expect(all.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(all.map((r) => r.body)).size).toBe(1);
    expect(inbound.rows.size).toBe(1);
    expect(published).toHaveLength(1);
  });

  it('INV-ING-DEDUPE-PER-TENANT: the same external_event_id in two tenants is two events', async () => {
    await post('acme', signedA('sec-acme'));
    await post('globex', signedA('sec-globex'));
    expect(inbound.rows.size).toBe(2);
    expect(published.map((p) => p.event.tenant_id).sort()).toEqual([T1, T2]);
  });

  it('INV-ING-ATOMIC: row and outbox message share one transaction; a failed publish leaves no row', async () => {
    publishFails = true;
    const failed = await post('acme', signedA('sec-acme'));
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(inbound.rows.size).toBe(0); // rolled back with the failed outbox write
    publishFails = false;
    txCalls.length = 0;
    const retry = await post('acme', signedA('sec-acme'));
    expect(retry.statusCode).toBe(200);
    expect(txCalls).toHaveLength(1); // one transaction for insert + outbox
    expect(published[0]!.tx).toBe(txCalls[0]);
    expect(inbound.rows.size).toBe(1);
  });

  // X-1. Mutation: resolve the player after the outbox write or at the consumer, or swallow an
  // identity failure and publish anyway. Identity down means 503 and NOTHING written: the inbound
  // row is not stored, so the casino's retry is not a dedupe hole.
  it('INV-ING-IDENTITY-DOWN: when identity cannot resolve the player the answer is 503, no row and no event; the retry then succeeds', async () => {
    identityDown = true;
    const down = await post('acme', signedA('sec-acme'));
    expect(down.statusCode).toBe(503);
    nothingHappened();
    identityDown = false;
    const retry = await post('acme', signedA('sec-acme'));
    expect(retry.statusCode).toBe(200);
    expect(IngestAck.parse(retry.json()).status).toBe('accepted');
    expect(inbound.rows.size).toBe(1);
    expect(published).toHaveLength(1);
  });

  // X-3/D-13. Mutation: copy `sandbox` from the body or a header, never set it, or set it for production.
  it('INV-ING-SANDBOX: a deposit through a sandbox integration is published with envelope.sandbox = true; a production one carries none', async () => {
    await post('sandboxed', signedA('sec-sbx'));
    await post('acme', signedA('sec-acme'));
    const byTenant = (t: string) => published.find((p) => p.event.tenant_id === t)!.event;
    expect(byTenant(T5).sandbox).toBe(true);
    expect('sandbox' in byTenant(T1)).toBe(false);
    // a client cannot ask for it: the body and a header are ignored
    const forged = signedA('sec-acme', { id: 'evt-forged' });
    const res = await post('acme', {
      raw: forged.raw,
      headers: { ...forged.headers, 'x-sandbox': '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(published.filter((p) => p.event.tenant_id === T1).every((p) => !p.event.sandbox)).toBe(
      true,
    );
  });

  it('INV-ING-PLAYER-HMAC: the inbound row stores an HMAC of the casino player id (tenant key), never the raw id; the raw id goes only to identity, which owns the mapping (D-12, X-1)', async () => {
    const res = await post('acme', signedA('sec-acme'));
    expect(res.statusCode).toBe(200);
    const { row } = [...inbound.rows.values()][0]!;
    // independent oracle: HMAC-SHA256(player_hash_key, `${source}\n${external_player_id}`) in hex
    const expected = hmac(HASH_KEYS.acme, 'casino-a\npl-1');
    expect(row.externalPlayerHmac).toBe(expected);
    expect(JSON.stringify(row)).not.toContain('pl-1'); // no field of the row holds the raw id
    expect(Object.keys(row)).not.toContain('externalPlayerId');
    // another tenant's key gives another hash for the same casino player
    await post('globex', signedA('sec-globex', { id: 'evt-g' }));
    const other = [...inbound.rows.values()].find((r) => r.row.tenantId === T2)!.row;
    expect(other.externalPlayerHmac).toBe(hmac(HASH_KEYS.globex, 'casino-a\npl-1'));
    expect(other.externalPlayerHmac).not.toBe(expected);
    // the same player at the other casino of the same tenant key space is a different hash too
    await post('bravo', signedB('sec-bravo'));
    const b = [...inbound.rows.values()].find((r) => r.row.tenantId === T3)!.row;
    expect(b.externalPlayerHmac).toBe(hmac(HASH_KEYS.bravo, 'casino-b\npl-1'));
    expect(published.every((p) => p.event.type === 'engagement.deposit.confirmed')).toBe(true);
    expect(JSON.stringify(published.map((p) => p.event))).not.toContain('pl-1');
    expect(resolved).toEqual(
      expect.arrayContaining([
        [T1, 'casino-a', 'pl-1'],
        [T2, 'casino-a', 'pl-1'],
        [T3, 'casino-b', 'pl-1'],
      ]),
    );
  });

  it('INV-ING-ROTATION: with two active secrets either verifies; after the old one is revoked it is refused', async () => {
    integrations.acme!.webhook_secrets = ['sec-new', 'sec-old'];
    expect((await post('acme', signedA('sec-old', { id: 'e-old' }))).statusCode).toBe(200);
    expect((await post('acme', signedA('sec-new', { id: 'e-new' }))).statusCode).toBe(200);
    integrations.acme!.webhook_secrets = ['sec-new'];
    const revoked = await post('acme', signedA('sec-old', { id: 'e-old2' }));
    expect(revoked.statusCode).toBe(401);
    expect(inbound.rows.size).toBe(2);
  });

  it('INV-ING-NO-SECRET-LEAK: a rejection body never echoes the body, the signature or a secret', async () => {
    const res = await post('acme', signedA('wrong-secret'));
    expect(res.body).not.toContain('sec-acme');
    expect(res.body).not.toContain('wrong-secret');
    expect(res.body).not.toContain('pl-1');
  });
});
