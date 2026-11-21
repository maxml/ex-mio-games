import { uuidv7 } from '@ex-mio/contracts';
import { LEDGER_JOBS_LOCK_ID } from '../model/ledger-jobs.repository';
import {
  activateSubscription,
  key,
  newPlayer,
  newTenant,
  openHarness,
  spinCompleted,
  type Harness,
} from '../testing/harness';
import { previousPeriod } from './ledger-jobs.service';

// Choke point: `LedgerJobsService.runOnce`, the one pass that the worker and `ledger-report` both run
// (D-20): reconciliation of every tenant, the usage report of the last complete month, a single-runner
// lock. The run record is read back through `ReconciliationService.last` (what the platform-admin route
// serves, see controllers/ledger-admin.controller.test.ts). Spec: docs/specs/payments.md, section 7.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

/** Some production activity so the tenant has accounts to check. */
async function activity(t: string, sandbox = false): Promise<string> {
  const p = newPlayer();
  if (sandbox) {
    await h.consume(spinCompleted(t, p, 9, { sandbox: true }));
  } else {
    await h.fund(t, p, 9);
  }
  await h.as(t, () =>
    h.ledger.reserve(
      { player_id: p, reserve_id: uuidv7(), amount: 4, currency: 'COIN', sandbox },
      key('r'),
    ),
  );
  return p;
}

const accountOf = async (t: string, kind: string, sandbox: boolean): Promise<string> =>
  (
    await h.admin.query(
      `SELECT id FROM accounts WHERE tenant_id = $1 AND kind = $2 AND sandbox = $3 LIMIT 1`,
      [t, kind, sandbox],
    )
  ).rows[0].id as string;

describe('previousPeriod', () => {
  it('is the calendar month before now, in UTC, across a year boundary', () => {
    expect(previousPeriod(new Date('2026-12-02T10:00:00.000Z'))).toBe('2026-11');
    expect(previousPeriod(new Date('2027-01-01T00:00:00.000Z'))).toBe('2026-12');
    expect(previousPeriod(new Date('2026-12-31T23:59:59.000Z'))).toBe('2026-11');
  });
});

describe('INV-JOB1 a pass reconciles every tenant and leaves a record the platform reads', () => {
  // Mutation: runOnce does not call runAll (the schedule would run and record nothing).
  it('after a pass the tenant has a run record, readable through last(): ok, with the accounts checked', async () => {
    const t = newTenant();
    await activity(t);
    expect(await h.as(t, () => h.recon.last())).toBeNull();
    const result = await h.jobs.runOnce();
    expect(result.ran).toBe(true);
    const last = await h.as(t, () => h.recon.last());
    expect(last).toMatchObject({ status: 'ok', accounts_checked: 4, stale: false });
    expect(last?.report).toMatchObject({ issued: 9, available: 5, held: 4, holds: true });
  });

  // Mutation: swallow a mismatch (status ok, no attention) or skip a tenant after the first failure.
  it('a balance edited behind the ledger is recorded as a mismatch and the pass asks for attention', async () => {
    const bad = newTenant();
    const good = newTenant();
    await activity(bad);
    await activity(good);
    const victim = await accountOf(bad, 'player_available', false);
    await h.admin.query(
      `UPDATE balances SET amount = amount + 1 WHERE tenant_id = $1 AND account_id = $2`,
      [bad, victim],
    );
    try {
      const result = await h.jobs.runOnce();
      expect(result.attention).toBe(true);
      const badRun = await h.as(bad, () => h.recon.last());
      expect(badRun).toMatchObject({ status: 'mismatch' });
      expect(badRun?.mismatches).toEqual([
        expect.objectContaining({ kind: 'balance_drift', account_id: victim }),
      ]);
      expect(await h.as(good, () => h.recon.last())).toMatchObject({ status: 'ok' });
    } finally {
      // leave the shared database clean for the passes of later tests
      await h.admin.query(
        `UPDATE balances SET amount = amount - 1 WHERE tenant_id = $1 AND account_id = $2`,
        [bad, victim],
      );
    }
  });

  // Mutation: reconcile production accounts only, or add sandbox coins to the production figures.
  it('sandbox accounts reconcile too, and their coins stay out of the production figures', async () => {
    const t = newTenant();
    await activity(t); // production: 9 issued, 5 available, 4 held
    await activity(t, true); // sandbox: another 9
    await h.jobs.runOnce();
    const ok = await h.as(t, () => h.recon.last());
    expect(ok).toMatchObject({ status: 'ok', accounts_checked: 8 });
    expect(ok?.report).toMatchObject({ issued: 9, available: 5, held: 4, holds: true });

    const victim = await accountOf(t, 'player_available', true);
    await h.admin.query(
      `UPDATE balances SET amount = amount + 2 WHERE tenant_id = $1 AND account_id = $2`,
      [t, victim],
    );
    try {
      await h.jobs.runOnce();
      const drift = await h.as(t, () => h.recon.last());
      expect(drift).toMatchObject({ status: 'mismatch' });
      expect(drift?.mismatches).toEqual([
        expect.objectContaining({ kind: 'balance_drift', account_id: victim }),
      ]);
      // conservation is broken in the sandbox ledger, so `holds` is false, production figures unchanged
      expect(drift?.report).toMatchObject({ issued: 9, available: 5, held: 4, holds: false });
    } finally {
      await h.admin.query(
        `UPDATE balances SET amount = amount - 2 WHERE tenant_id = $1 AND account_id = $2`,
        [t, victim],
      );
    }
  });
});

describe('INV-JOB2 only one process runs a pass at a time', () => {
  // Mutation: drop the advisory lock (replicas would double the scan and the usage report).
  it('while another process holds the lock nothing runs; after it is released a pass runs', async () => {
    const t = newTenant();
    await activity(t);
    await h.admin.query('SELECT pg_advisory_lock($1)', [LEDGER_JOBS_LOCK_ID]);
    try {
      const held = await h.jobs.runOnce();
      expect(held).toMatchObject({ ran: false, reconciliation: [], usage: [] });
      expect(await h.as(t, () => h.recon.last())).toBeNull();
    } finally {
      await h.admin.query('SELECT pg_advisory_unlock($1)', [LEDGER_JOBS_LOCK_ID]);
    }
    expect((await h.jobs.runOnce()).ran).toBe(true);
    expect(await h.as(t, () => h.recon.last())).toMatchObject({ status: 'ok' });
  });
});

describe('INV-JOB3 the usage report of the last complete month goes out once per tenant with a plan', () => {
  const sent = (t: string) =>
    h.provider.recordedUsage().filter((u) => u.idempotencyKey.includes(t));

  // Mutation: never call the usage report from the pass, or report a tenant with no subscription.
  it('reports the previous month for a subscribed tenant, skips one without a plan, and a second pass bills nothing twice', async () => {
    const paid = newTenant();
    const free = newTenant();
    await activateSubscription(h, paid);
    for (const t of [paid, free]) {
      await h.consume(spinCompleted(t, newPlayer(), 5, { at: '2026-11-05T10:00:00.000Z' }));
      await h.consume(spinCompleted(t, newPlayer(), 5, { at: '2026-11-06T10:00:00.000Z' }));
    }
    const now = new Date('2026-12-02T03:00:00.000Z');
    const first = await h.jobs.runOnce(now);
    expect(first.usage.find((u) => u.tenantId === paid)).toMatchObject({
      period: '2026-11',
      outcome: 'reported',
      quantity: 2,
    });
    expect(first.usage.find((u) => u.tenantId === free)).toMatchObject({
      outcome: 'no_subscription',
    });
    expect(sent(paid)).toHaveLength(1);
    expect(sent(paid)[0]).toMatchObject({ idempotencyKey: `usage:${paid}:2026-11`, quantity: 2 });
    expect(sent(free)).toHaveLength(0);

    await h.jobs.runOnce(now);
    expect(sent(paid)).toHaveLength(1);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM usage_reports WHERE tenant_id = $1`,
      [paid],
    );
    expect(rows[0].n).toBe(1);
  });
});
