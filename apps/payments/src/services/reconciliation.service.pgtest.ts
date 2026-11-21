import { uuidv7 } from '@ex-mio/contracts';
import { key, newPlayer, newTenant, openHarness, type Harness } from '../testing/harness';

// Choke point: `ReconciliationService.run` (sum of legs == materialised balance, conservation report).
// Spec: docs/specs/payments.md, section 7.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

async function activity(t: string) {
  const p = newPlayer();
  const credit = (amount: number) =>
    h.as(t, () =>
      h.ledger.credit({ player_id: p, spin_id: uuidv7(), amount, currency: 'COIN' }, key('c')),
    );
  await credit(20);
  const a = uuidv7();
  const b = uuidv7();
  const c = uuidv7();
  const rsv = (id: string, amount: number) =>
    h.as(t, () =>
      h.ledger.reserve({ player_id: p, reserve_id: id, amount, currency: 'COIN' }, key('r')),
    );
  await rsv(a, 5);
  await rsv(b, 4);
  await rsv(c, 3);
  await h.as(t, () => h.ledger.capture({ reserve_id: a }, key('cap')));
  await h.as(t, () => h.ledger.release({ reserve_id: b }, key('rel')));
  await h.as(t, () => h.ledger.capture({ reserve_id: c }, key('cap')));
  await h.as(t, () => h.ledger.refund({ reserve_id: c }, key('ref')));
  return p;
}

describe('INV-R1 reconciliation reports a clean ledger as ok and states conservation', () => {
  // Mutation: have run() always return status 'ok', or compute `holds` as a constant.
  it('no mismatches, and issued = available + held + captured - refunded', async () => {
    const t = newTenant();
    await activity(t);
    const run = await h.as(t, () => h.recon.run());
    expect(run.status).toBe('ok');
    expect(run.mismatches).toEqual([]);
    expect(run.accounts_checked).toBeGreaterThanOrEqual(4);
    expect(run.report).toEqual({
      issued: 20,
      available: 15,
      held: 0,
      captured: 8,
      released: 4,
      refunded: 3,
      holds: true,
    });
  });
});

describe('INV-R2 reconciliation detects tampering with a balance', () => {
  // Mutation: compare the balance with itself, or skip an account kind in the scan.
  it('a balance edited behind the ledger is reported for exactly that account', async () => {
    const t = newTenant();
    await activity(t);
    const { rows } = await h.admin.query(
      `SELECT b.account_id FROM balances b JOIN accounts a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
        WHERE b.tenant_id = $1 AND a.kind = 'player_available'`,
      [t],
    );
    const victim = rows[0].account_id as string;
    await h.admin.query(
      `UPDATE balances SET amount = amount + 1 WHERE tenant_id = $1 AND account_id = $2`,
      [t, victim],
    );
    const run = await h.as(t, () => h.recon.run());
    expect(run.status).toBe('mismatch');
    expect(run.mismatches).toEqual([
      { kind: 'balance_drift', account_id: victim, expected: 15, actual: 16 },
    ]);
    expect(run.report?.holds).toBe(false);
  });

  // Mutation: let the job repair the balance.
  it('never repairs: the tampered value is still there after the run', async () => {
    const t = newTenant();
    await activity(t);
    const availableAmount = () =>
      h.admin
        .query(
          `SELECT b.amount::int AS amount FROM balances b JOIN accounts a
             ON a.tenant_id = b.tenant_id AND a.id = b.account_id
            WHERE b.tenant_id = $1 AND a.kind = 'player_available'`,
          [t],
        )
        .then((r) => r.rows[0].amount as number);
    await h.admin.query(
      `UPDATE balances SET amount = amount + 5 WHERE tenant_id = $1 AND amount = 15`,
      [t],
    );
    expect(await availableAmount()).toBe(20);
    await h.as(t, () => h.recon.run());
    expect(await availableAmount()).toBe(20);
  });
});

describe('INV-R3 the run record is durable, read back correctly, and a failure is not "ok"', () => {
  // Mutation: do not persist the run, or persist failed runs as ok.
  it('the last run is read back with its time, accounts checked and mismatches', async () => {
    const t = newTenant();
    await activity(t);
    const run = await h.as(t, () => h.recon.run());
    const last = await h.as(t, () => h.recon.last());
    expect(last).toMatchObject({
      id: run.id,
      status: 'ok',
      accounts_checked: run.accounts_checked,
      mismatches: [],
      stale: false,
    });
    expect(new Date(last!.finished_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a run that dies is recorded as failed, and run() does not report success', async () => {
    const t = newTenant();
    await activity(t);
    h.failAt('reconciliation_scan');
    const run = await h.as(t, () => h.recon.run());
    expect(run.status).toBe('failed');
    expect((await h.as(t, () => h.recon.last()))!.status).toBe('failed');
  });

  // Mutation: drop the staleness rule from last().
  it('a last run older than two hours is shown as stale', async () => {
    const t = newTenant();
    await activity(t);
    await h.as(t, () => h.recon.run());
    await h.admin.query(
      `UPDATE reconciliation_runs SET started_at = now() - interval '3 hours', finished_at = now() - interval '3 hours' WHERE tenant_id = $1`,
      [t],
    );
    expect(await h.as(t, () => h.recon.last())).toMatchObject({ stale: true });
  });
});
