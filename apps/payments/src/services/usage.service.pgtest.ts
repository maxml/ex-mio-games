import { uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import {
  activateSubscription,
  newPlayer,
  newTenant,
  openHarness,
  spinCompleted,
  type Harness,
} from '../testing/harness';

// Choke point: `UsageService.handle` (the handler that meters spins and monthly active players, also
// run by the inbox handler inside the spin delivery) and `UsageService.report` / `reportToProvider`.
// Spec: docs/specs/payments.md, section 8.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

const spin = (tenant: string, player: string, at: string, eventId?: string): EventEnvelope =>
  spinCompleted(tenant, player, 5, { at, eventId });

const deliver = (t: string, e: EventEnvelope) => h.deliver(t, (m) => h.usage.handle(m, e));
const report = (t: string, period: string) => h.as(t, () => h.usage.report(period));

describe('INV-M1 a redelivered event is counted once', () => {
  // Mutation: drop the (tenant_id, event_id) primary key on usage_events, or count before the dedupe check.
  it('the same event delivered twice, also in parallel, adds one spin', async () => {
    const t = newTenant();
    const e = spin(t, newPlayer(), '2026-11-05T10:00:00.000Z');
    await Promise.allSettled([deliver(t, e), deliver(t, e)]);
    await deliver(t, e);
    expect(await report(t, '2026-11')).toEqual({
      period: '2026-11',
      spins: 1,
      monthly_active_players: 1,
    });
  });
});

describe('INV-M6 one spin is metered once, whatever event carries it (reviewer, Stage B gap b)', () => {
  // D-1: engagement may re-publish the same spin under a NEW event_id (outbox replay, D1-4). The ledger
  // dedupes that by spin_id; metering deduped by event_id only, so the tenant was billed twice.
  // Mutation: dedupe usage by `event_id` instead of the business key `(tenant_id, spin_id)`.
  it('the same spin_id under three event ids, also in parallel, is one spin and one MAU', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spinId = uuidv7();
    const at = '2026-11-05T10:00:00.000Z';
    const copies = [0, 1, 2].map(() => spinCompleted(t, p, 5, { spinId, at }));
    expect(new Set(copies.map((e) => e.event_id)).size).toBe(3);
    await Promise.allSettled([deliver(t, copies[0]!), deliver(t, copies[1]!)]);
    await deliver(t, copies[2]!);
    expect(await report(t, '2026-11')).toEqual({
      period: '2026-11',
      spins: 1,
      monthly_active_players: 1,
    });
  });

  // Mutation: scope the business key by period (a re-publish stamped in the next month bills again).
  it('a re-publish stamped in the next month does not add a spin to that month', async () => {
    const t = newTenant();
    const p = newPlayer();
    const spinId = uuidv7();
    await deliver(t, spinCompleted(t, p, 5, { spinId, at: '2026-11-30T23:59:59.000Z' }));
    await deliver(t, spinCompleted(t, p, 5, { spinId, at: '2026-12-01T00:00:01.000Z' }));
    expect(await report(t, '2026-11')).toMatchObject({ spins: 1 });
    expect(await report(t, '2026-12')).toMatchObject({ spins: 0, monthly_active_players: 0 });
  });

  // Guard against over-correction: different spins of one player are still each metered.
  it('two different spins are two spins', async () => {
    const t = newTenant();
    const p = newPlayer();
    const at = '2026-11-05T10:00:00.000Z';
    await deliver(t, spinCompleted(t, p, 5, { at }));
    await deliver(t, spinCompleted(t, p, 5, { at }));
    expect(await report(t, '2026-11')).toMatchObject({ spins: 2, monthly_active_players: 1 });
  });
});

describe('INV-M2 a player active on many days is one monthly active player', () => {
  // Mutation: count MAU as the number of events instead of distinct players.
  it('ten days, one player: 10 spins, 1 MAU; a second player makes 2', async () => {
    const t = newTenant();
    const p = newPlayer();
    for (let day = 1; day <= 10; day++) {
      await deliver(t, spin(t, p, `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`));
    }
    expect(await report(t, '2026-11')).toMatchObject({ spins: 10, monthly_active_players: 1 });
    await deliver(t, spin(t, newPlayer(), '2026-11-11T09:00:00.000Z'));
    expect(await report(t, '2026-11')).toMatchObject({ spins: 11, monthly_active_players: 2 });
  });
});

describe('INV-M3 meters are per tenant and per period', () => {
  // Mutation: key the meter by period only, or sum across tenants.
  it('another tenant and another month are separate', async () => {
    const a = newTenant();
    const b = newTenant();
    const p = newPlayer();
    await deliver(a, spin(a, p, '2026-11-05T10:00:00.000Z'));
    await deliver(a, spin(a, p, '2026-12-01T00:00:00.000Z'));
    await deliver(b, spin(b, p, '2026-11-06T10:00:00.000Z'));
    expect(await report(a, '2026-11')).toMatchObject({ spins: 1, monthly_active_players: 1 });
    expect(await report(a, '2026-12')).toMatchObject({ spins: 1, monthly_active_players: 1 });
    expect(await report(b, '2026-11')).toMatchObject({ spins: 1, monthly_active_players: 1 });
    expect(await report(b, '2026-12')).toMatchObject({ spins: 0, monthly_active_players: 0 });
  });
});

describe('INV-M4 the usage report sent to the provider twice is billed once', () => {
  const sent = (t: string) =>
    h.provider.recordedUsage().filter((u) => u.idempotencyKey.includes(t));

  // Mutation: send the report without its stable idempotency key `usage:<tenant>:<period>`. Our own
  // usage_reports row dedupes by itself, so only what the PROVIDER recorded can catch this.
  it('reportToProvider twice: the provider recorded one billing under the stable key', async () => {
    const t = newTenant();
    await activateSubscription(h, t);
    await deliver(t, spin(t, newPlayer(), '2026-11-05T10:00:00.000Z'));
    await h.as(t, () => h.usage.reportToProvider('2026-11'));
    await h.as(t, () => h.usage.reportToProvider('2026-11'));
    expect(sent(t)).toHaveLength(1);
    expect(sent(t)[0]).toMatchObject({
      idempotencyKey: `usage:${t}:2026-11`,
      period: '2026-11',
      quantity: 1,
    });
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM usage_reports WHERE tenant_id = $1 AND period = '2026-11'`,
      [t],
    );
    expect(rows[0].n).toBe(1);
  });

  // Mutation: record the report row BEFORE the provider call succeeds, or derive the key from time.
  it('the provider call succeeds and the record insert fails: the retry bills nothing twice', async () => {
    const t = newTenant();
    await activateSubscription(h, t);
    await deliver(t, spin(t, newPlayer(), '2026-11-05T10:00:00.000Z'));
    const fired = h.faultsFired();
    h.failAt('after_usage_report_sent');
    await expect(h.as(t, () => h.usage.reportToProvider('2026-11'))).rejects.toThrow(
      /injected fault/,
    );
    expect(h.faultsFired()).toBe(fired + 1);
    expect(sent(t)).toHaveLength(1); // the provider did record it
    const count = () =>
      h.admin
        .query(`SELECT count(*)::int AS n FROM usage_reports WHERE tenant_id = $1`, [t])
        .then((r) => r.rows[0].n as number);
    expect(await count()).toBe(0);
    await h.as(t, () => h.usage.reportToProvider('2026-11'));
    expect(sent(t)).toHaveLength(1); // still billed once
    expect(await count()).toBe(1);
  });

  it('a tenant without an active subscription reports nothing to the provider', async () => {
    const t = newTenant();
    await deliver(t, spin(t, newPlayer(), '2026-11-05T10:00:00.000Z'));
    await expect(h.as(t, () => h.usage.reportToProvider('2026-11'))).rejects.toThrow();
    expect(sent(t)).toHaveLength(0);
  });
});

describe('INV-M5 the sandbox flag comes from the producer, never from the payload (MIO-095)', () => {
  // Mutation: decide from `payload.test` / `payload.sandbox` (client-controlled data), or ignore
  // `envelope.sandbox`, so that a sandbox tenant's traffic is billed or a marked production spin is not.
  it('a production event with test:true / sandbox:true in its payload IS metered', async () => {
    const t = newTenant();
    await deliver(
      t,
      spinCompleted(t, newPlayer(), 5, {
        at: '2026-11-05T10:00:00.000Z',
        payload: { test: true, sandbox: true },
      }),
    );
    expect(await report(t, '2026-11')).toMatchObject({ spins: 1, monthly_active_players: 1 });
  });

  it('an event the producer marked sandbox is NOT metered (no spin, no MAU, no usage row)', async () => {
    const t = newTenant();
    await deliver(
      t,
      spinCompleted(t, newPlayer(), 5, { at: '2026-11-05T10:00:00.000Z', sandbox: true }),
    );
    expect(await report(t, '2026-11')).toMatchObject({ spins: 0, monthly_active_players: 0 });
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM usage_events WHERE tenant_id = $1`,
      [t],
    );
    expect(rows[0].n).toBe(0);
  });

  // Reviewer fix (Stage B): this test used to assert the sandbox coins in `h.dbWallet`, the wallet linked
  // to the player, i.e. the production wallet. D-15 (X-2) forbids exactly that; where the sandbox coins
  // must NOT go is pinned in spin-credit.consumer.pgtest.ts, "X-2".
  it('through the inbox a sandbox spin is applied and acked but meters nothing', async () => {
    const t = newTenant();
    const p = newPlayer();
    const d = await h.consume(
      spinCompleted(t, p, 5, { at: '2026-11-05T10:00:00.000Z', sandbox: true }),
    );
    expect(d.outcome).toBe('applied');
    expect(d.acked).toBe(true);
    expect(await report(t, '2026-11')).toMatchObject({ spins: 0, monthly_active_players: 0 });
  });
});

describe('INV-O3 erasure leaves the meters alone and metering stores no user id (F19)', () => {
  // Mutation: key MAU rows by the raw player id, or delete usage on erasure (billing evidence).
  it('erasing the identity link does not change the report, and usage tables hold no player id', async () => {
    const t = newTenant();
    const p = newPlayer();
    await h.consume(spinCompleted(t, p, 5, { at: '2026-11-05T10:00:00.000Z' }));
    const before = await report(t, '2026-11');
    await h.as(t, () => h.ledger.eraseIdentityLink(p));
    expect(await report(t, '2026-11')).toEqual(before);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM usage_players WHERE tenant_id = $1 AND player_key::text LIKE '%' || $2 || '%'`,
      [t, p],
    );
    expect(rows[0].n).toBe(0);
  });
});
