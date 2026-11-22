import 'reflect-metadata';
import { Controller, Get, NotFoundException, Module, Post, Body } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ActingRequestAuditedV1,
  createEvent,
  type EventEnvelope,
  PLATFORM_TENANT_ID,
  ServiceCallAuditedV1,
  type ServiceCallPolicy,
} from '@ex-mio/contracts';
import {
  AUDIT_INTENT_SWEEP_AFTER_SECONDS,
  AuditIntentGoneError,
  createOutboxAuditPort,
  type OutboxAuditPort,
} from './audit-intents';
import type { Db } from './db';
import { ServiceAuthModule } from './service-auth';
import { accessClaims, generateRsaKey, serviceClaims, signJwt } from './testing/jwt-fixtures';

/*
 * Reviewer tests (identity epic review, D-21 M1): the two-step audit, tested against the OUTBOX
 * the relay reads, not against an audit port that keeps a reference to the event object.
 *
 * The frozen INV-AUTH-9 tests hand the entry point a port that pushes the event object itself, and
 * `finish` later mutates that same object; they read the final value through aliasing and would
 * pass even if the provisional value were what got published. Here the port is the real
 * `createOutboxAuditPort`, over an in-memory database whose every write is a SNAPSHOT
 * (`JSON.stringify` at the moment of the write), with transactions that commit or roll back as a
 * whole. "Published" means "taken from the outbox by a relay tick", exactly like bus/outbox.ts.
 * The same properties are pinned on real Postgres in tests/compose/src/audit-intents.compose.test.ts.
 *
 * Each test names the mutation that must turn it red.
 */

const T_B = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const USER = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const NOW = 1_800_000_000;
const key = generateRsaKey('k1');

// ---- a snapshotting outbox database ------------------------------------------------------------

type Row = { event_id: string; envelope: string };

/**
 * The three statements `createOutboxAuditPort` runs, plus `Db.publish`, over plain data. Every
 * stored value is a string snapshot. Transactions are serialised (Postgres would block the second
 * DELETE on the row lock and then see the row gone; serialising gives the same outcomes). Any other
 * SQL fails the test, so the fake cannot silently accept a statement it does not model.
 */
class SnapshotOutboxDb {
  intents = new Map<string, { envelope: string; createdAtMs: number }>();
  outbox: Row[] = [];
  published: Row[] = [];
  nowMs = NOW * 1000;
  failIntentInsert = false;
  private chain: Promise<unknown> = Promise.resolve();

  platformTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.runTx(fn));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const staged = { intents: new Map(this.intents), outbox: [...this.outbox] };
    const tx = {
      staged,
      query: async (sql: string, params: unknown[] = []): Promise<unknown> => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (
          /^INSERT INTO "audit_intents" \("event_id", "envelope"\) VALUES \(\$1, \$2\)$/.test(s)
        ) {
          if (this.failIntentInsert) throw new Error('connection terminated');
          const id = String(params[0]);
          if (staged.intents.has(id)) throw new Error('duplicate key value violates unique');
          staged.intents.set(id, { envelope: String(params[1]), createdAtMs: this.nowMs });
          return [];
        }
        if (/^DELETE FROM "audit_intents" WHERE "event_id" = \$1 RETURNING "event_id"$/.test(s)) {
          const id = String(params[0]);
          if (!staged.intents.has(id)) return [[], 0];
          staged.intents.delete(id);
          return [[{ event_id: id }], 1];
        }
        if (
          /^DELETE FROM "audit_intents" WHERE "created_at" < now\(\) - make_interval\(secs => \$1\) RETURNING "event_id", "envelope"$/.test(
            s,
          )
        ) {
          const cutoff = this.nowMs - Number(params[0]) * 1000;
          const old = [...staged.intents.entries()].filter(([, v]) => v.createdAtMs < cutoff);
          for (const [id] of old) staged.intents.delete(id);
          const rows = old.map(([id, v]) => ({ event_id: id, envelope: JSON.parse(v.envelope) }));
          return [rows, rows.length];
        }
        throw new Error(`SnapshotOutboxDb: unexpected SQL: ${s}`);
      },
    };
    const result = await fn(tx);
    this.intents = staged.intents;
    this.outbox = staged.outbox;
    return result;
  }

  /** `Db.publish`: the outbox row is written in the caller's transaction, as a snapshot. */
  async publish(tx: unknown, event: EventEnvelope): Promise<void> {
    const t = tx as { staged?: { outbox: Row[] } };
    if (!t?.staged) throw new Error('publish outside a transaction');
    t.staged.outbox.push({ event_id: event.event_id, envelope: JSON.stringify(event) });
  }

  /** One relay tick (bus/outbox.ts pollOnce): every committed, unpublished outbox row goes out. */
  relayTick(): number {
    const fresh = this.outbox.filter((r) => !this.published.some((p) => p.event_id === r.event_id));
    this.published.push(...fresh);
    return fresh.length;
  }

  publishedEvents(): EventEnvelope[] {
    return this.published.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }

  outboxEvents(): EventEnvelope[] {
    return this.outbox.map((r) => JSON.parse(r.envelope) as EventEnvelope);
  }
}

// ---- the entry point over that database --------------------------------------------------------

const ran = { n: 0 };
let gate: { entered: () => void; release: Promise<void> } | undefined;

@Controller()
class Probe {
  @Get('v1/ok')
  ok() {
    ran.n++;
    return { ok: true };
  }

  @Get('v1/missing')
  missing() {
    ran.n++;
    throw new NotFoundException();
  }

  /** Waits for the test: the window between the intent write and the finalize. */
  @Get('v1/slow')
  async slow() {
    ran.n++;
    const g = gate;
    if (g) {
      g.entered();
      await g.release;
    }
    return { ok: true };
  }

  @Post('internal/v1/tenants/:tenantId/ping')
  internalAllowed(@Body() _b: unknown) {
    ran.n++;
    return { ok: true };
  }

  @Post('internal/v1/tenants/:tenantId/admin/mint')
  internalForbidden(@Body() _b: unknown) {
    ran.n++;
    return { LEAK: true };
  }
}

const POLICY: ServiceCallPolicy = {
  identity: {},
  engagement: {},
  payments: { engagement: ['POST /internal/v1/tenants/:tenantId/ping'] },
};

const open: NestFastifyApplication[] = [];
afterAll(async () => {
  await Promise.all(open.map((a) => a.close()));
});

async function boot() {
  const db = new SnapshotOutboxDb();
  const port = createOutboxAuditPort(() => db as unknown as Db);
  ran.n = 0;
  @Module({
    imports: [
      ServiceAuthModule.forService({
        audience: 'engagement',
        serviceCalls: POLICY,
        auditPort: port,
        jwks: async () => ({ keys: [key.publicJwk] }),
        tenantStatus: async () => 'active',
        nowSeconds: () => NOW,
      }),
    ],
    controllers: [Probe],
  })
  class App {}
  const app = await NestFactory.create<NestFastifyApplication>(App, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  open.push(app);
  type Res = { statusCode: number; json: () => Record<string, unknown> };
  const inject = (opts: { method: 'GET' | 'POST'; url: string; payload?: unknown }) => {
    const token = opts.url.startsWith('/internal') ? svc() : acting();
    const headers = { authorization: `Bearer ${token}` };
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({ ...opts, headers } as never) as unknown as Promise<Res>;
  };
  return { db, port, inject };
}

const acting = () =>
  signJwt({
    alg: 'RS256',
    key: key.privateKey,
    kid: 'k1',
    claims: accessClaims({
      now: NOW,
      sub: USER,
      tid: PLATFORM_TENANT_ID,
      roles: ['platform_admin'],
      act: { tenant_id: T_B, reason: 'ticket 42' },
      ttl: 900,
    }),
  });
const svc = () =>
  signJwt({
    alg: 'RS256',
    key: key.privateKey,
    kid: 'k1',
    claims: serviceClaims({ now: NOW, service: 'payments', aud: 'engagement' }),
  });

/** Finalize runs after the response is sent; give it the turns it needs, no wall-clock sleep. */
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r));
};

const auditEvent = () =>
  createEvent({
    type: 'audit.acting_request',
    tenantId: T_B,
    sandbox: false,
    payload: {
      actor_user_id: USER,
      actor_tenant_id: PLATFORM_TENANT_ID,
      acting_tenant_id: T_B,
      reason: 'ticket 42',
      service: 'engagement',
      method: 'GET',
      route: 'GET /v1/slow',
      decision: 'allowed',
      status: 200,
      request_id: 'req-1',
      occurred_at: new Date(NOW * 1000).toISOString(),
    },
  });

describe('M1 two-step audit against the outbox (D-21, reviewer tests)', () => {
  // Mutation: createOutboxAuditPort's write calls `db.publish` (outbox) instead of inserting the
  // intent, or finish runs before the handler.
  it('M1-1 nothing reaches the outbox before finalize: while the handler runs there is an intent and no outbox row', async () => {
    const b = await boot();
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    gate = { entered, release: new Promise<void>((r) => (release = r)) };
    const pending = b.inject({ method: 'GET', url: '/v1/slow' });
    await inside;
    expect(b.db.intents.size).toBe(1);
    expect(b.db.outbox).toEqual([]);
    release();
    const res = await pending;
    gate = undefined;
    expect(res.statusCode).toBe(200);
    await settle(() => b.db.outbox.length > 0);
    expect(b.db.outbox).toHaveLength(1);
    expect(b.db.intents.size).toBe(0);
  });

  // Mutation: as above, or a relay that reads `audit_intents` too.
  it('M1-2 a relay tick between the intent write and finalize publishes nothing; the next tick publishes the final event once', async () => {
    const b = await boot();
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    gate = { entered, release: new Promise<void>((r) => (release = r)) };
    const pending = b.inject({ method: 'GET', url: '/v1/slow' });
    await inside;
    expect(b.db.relayTick()).toBe(0);
    expect(b.db.published).toEqual([]);
    release();
    await pending;
    gate = undefined;
    await settle(() => b.db.outbox.length > 0);
    expect(b.db.relayTick()).toBe(1);
    expect(b.db.relayTick()).toBe(0);
    const [event] = b.db.publishedEvents();
    expect(ActingRequestAuditedV1.parse(event?.payload)).toMatchObject({
      route: 'GET /v1/slow',
      decision: 'allowed',
      status: 200,
    });
  });

  // Mutation: finalize publishes the envelope stored with the intent (the provisional outcome), or
  // does not delete the intent (it would later be swept as a second, `aborted`, event).
  // int/all review, D-24 amendment: a 404 from the handler is `allowed` (no guard refused) with the
  // real status 404; the provisional outcome differs from it in status (the intent is written as
  // 200 before the handler), so publishing the stored intent still turns this red.
  it('M1-3 finalize publishes the REAL decision and status and deletes the intent, in one transaction', async () => {
    const b = await boot();
    const res = await b.inject({ method: 'GET', url: '/v1/missing' });
    expect(res.statusCode).toBe(404);
    await settle(() => b.db.outbox.length > 0);
    expect(b.db.intents.size).toBe(0);
    expect(b.db.relayTick()).toBe(1);
    const events = b.db.publishedEvents();
    expect(events).toHaveLength(1);
    expect(ActingRequestAuditedV1.parse(events[0]?.payload)).toMatchObject({
      decision: 'allowed',
      status: 404,
      route: 'GET /v1/missing',
    });
    // nothing left for the sweeper: a later sweep publishes no second (aborted) event
    b.db.nowMs += (AUDIT_INTENT_SWEEP_AFTER_SECONDS + 1) * 1000;
    expect(await b.port.sweep()).toBe(0);
    expect(b.db.outbox).toHaveLength(1);
  });

  // Mutation: an allowed internal call published at write time, or finalized with the provisional
  // outcome.
  it('M1-3b an allowed internal service call is published once, after the response, as allowed with the real status', async () => {
    const b = await boot();
    const res = await b.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${T_B}/ping`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    await settle(() => b.db.outbox.length > 0);
    expect(b.db.intents.size).toBe(0);
    b.db.relayTick();
    const calls = b.db.publishedEvents().filter((e) => e.type === 'audit.service_call');
    expect(calls).toHaveLength(1);
    expect(ServiceCallAuditedV1.parse(calls[0]?.payload)).toMatchObject({
      decision: 'allowed',
      status: 201,
    });
  });

  // A refusal the guard itself decides (D-14 allow-list) has a known outcome; it must be published
  // as refused/403 at once. Mutation: `writeFinal` goes through the intent path with no finalize
  // (today's code): the refusal sits in audit_intents and is swept 60 s later as aborted/500.
  it('M1-3c a refused internal call (outside the allow-list) is published as refused/403, never left as an intent', async () => {
    const b = await boot();
    const res = await b.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${T_B}/admin/mint`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(ran.n).toBe(0);
    await settle(() => b.db.outbox.length > 0);
    expect(b.db.intents.size).toBe(0);
    b.db.nowMs += (AUDIT_INTENT_SWEEP_AFTER_SECONDS + 1) * 1000;
    await b.port.sweep();
    b.db.relayTick();
    const calls = b.db.publishedEvents().filter((e) => e.type === 'audit.service_call');
    expect(calls).toHaveLength(1);
    expect(ServiceCallAuditedV1.parse(calls[0]?.payload)).toMatchObject({
      decision: 'refused',
      status: 403,
    });
  });

  // Mutation: sweep threshold 0 (or `<=` on a shorter window), or sweep without the age filter.
  it('M1-4 the sweep publishes an unfinished intent as aborted only after 60 s', async () => {
    const b = await boot();
    const event = auditEvent();
    await b.port(event);
    b.db.nowMs += AUDIT_INTENT_SWEEP_AFTER_SECONDS * 1000 - 1000; // 59 s
    expect(AUDIT_INTENT_SWEEP_AFTER_SECONDS).toBe(60);
    expect(await b.port.sweep()).toBe(0);
    expect(b.db.outbox).toEqual([]);
    b.db.nowMs += 2000; // 61 s
    expect(await b.port.sweep()).toBe(1);
    expect(b.db.intents.size).toBe(0);
    b.db.relayTick();
    const [published] = b.db.publishedEvents();
    expect(published?.event_id).toBe(event.event_id);
    expect(ActingRequestAuditedV1.parse(published?.payload)).toMatchObject({
      decision: 'aborted',
      status: 500,
    });
  });

  // Mutation: drop `if (gone.length !== 1) throw` in finalize (it would publish after the sweep did).
  it.each([
    ['finalize first', true],
    ['sweep first', false],
  ])(
    'M1-5 finalize and sweep racing on one intent publish exactly one event (%s)',
    async (_name, finalizeFirst) => {
      const b = await boot();
      const event = auditEvent();
      await b.port(event);
      b.db.nowMs += (AUDIT_INTENT_SWEEP_AFTER_SECONDS + 1) * 1000;
      const final = JSON.parse(JSON.stringify(event)) as EventEnvelope;
      Object.assign(final.payload as object, { decision: 'refused', status: 403 });
      const results = await Promise.allSettled(
        finalizeFirst
          ? [b.port.finalize(final), b.port.sweep()]
          : [b.port.sweep(), b.port.finalize(final)],
      );
      expect(b.db.outbox.filter((r) => r.event_id === event.event_id)).toHaveLength(1);
      expect(b.db.intents.size).toBe(0);
      const decision = (b.db.outboxEvents()[0]?.payload as { decision: string }).decision;
      if (finalizeFirst) {
        expect(decision).toBe('refused');
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      } else {
        expect(decision).toBe('aborted');
        expect(results[1]).toMatchObject({ status: 'rejected' });
        expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(AuditIntentGoneError);
      }
    },
  );

  // Mutation: catch the failed intent insert and continue (fire and forget).
  it('M1-6 when the intent insert fails the request gets 503 AUDIT_UNAVAILABLE and the handler does not run', async () => {
    const b = await boot();
    b.db.failIntentInsert = true;
    const res = await b.inject({ method: 'GET', url: '/v1/ok' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(ran.n).toBe(0);
    expect(b.db.outbox).toEqual([]);
    expect(b.db.intents.size).toBe(0);
    // the same for an allowed internal call
    const call = await b.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${T_B}/ping`,
      payload: {},
    });
    expect(call.statusCode).toBe(503);
    expect(ran.n).toBe(0);
  });

  it('the fake is the outbox port the entry point really uses (not an explicit aliasing port)', () => {
    const port: OutboxAuditPort = createOutboxAuditPort(() => new SnapshotOutboxDb() as never);
    expect(typeof port.finalize).toBe('function');
    expect(typeof port.sweep).toBe('function');
  });
});
