import { uuidv7 } from '@ex-mio/contracts';
import { key, newPlayer, newTenant, openHarness, type Harness } from '../testing/harness';

// Choke point: `ReconciliationService.run` (sum of legs == materialised balance, every transaction
// balances, every reserve agrees with its transactions, conservation report).
// Spec: docs/specs/payments.md, section 7.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => h.close());

async function activity(t: string) {
  const p = newPlayer();
  await h.fund(t, p, 20);
  const a = uuidv7();
  const b = uuidv7();
  const c = uuidv7();
  const rsv = (id: string, amount: number) =>
    h.as(t, () =>
      h.ledger.reserve(
        { player_id: p, reserve_id: id, amount, currency: 'COIN', sandbox: false },
        key('r'),
      ),
    );
  await rsv(a, 5);
  await rsv(b, 4);
  await rsv(c, 3);
  await h.as(t, () => h.ledger.capture({ reserve_id: a }, key('cap')));
  await h.as(t, () => h.ledger.release({ reserve_id: b }, key('rel')));
  await h.as(t, () => h.ledger.capture({ reserve_id: c }, key('cap')));
  await h.as(t, () => h.ledger.refund({ reserve_id: c }, key('ref')));
  return { player: p, reserves: { a, b, c } };
}

const KINDS = ['player_available', 'player_held', 'tenant_issuance', 'tenant_redeemed'] as const;
const EXPECTED = { player_available: 15, player_held: 0, tenant_issuance: 20, tenant_redeemed: 5 };

async function accountOf(t: string, kind: (typeof KINDS)[number]): Promise<string> {
  const { rows } = await h.admin.query(
    `SELECT id FROM accounts WHERE tenant_id = $1 AND kind = $2`,
    [t, kind],
  );
  return rows[0].id as string;
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

describe('INV-R2 reconciliation detects tampering, for every account kind', () => {
  // Mutation: compare the balance with itself, or skip an account kind in the scan.
  it.each(KINDS)(
    'a %s balance edited behind the ledger is reported for exactly that account',
    async (kind) => {
      const t = newTenant();
      await activity(t);
      const victim = await accountOf(t, kind);
      await h.admin.query(
        `UPDATE balances SET amount = amount + 1 WHERE tenant_id = $1 AND account_id = $2`,
        [t, victim],
      );
      const run = await h.as(t, () => h.recon.run());
      expect(run.status).toBe('mismatch');
      expect(run.mismatches).toHaveLength(1);
      expect(run.mismatches[0]).toMatchObject({
        kind: 'balance_drift',
        account_id: victim,
        reserve_id: null,
        transaction_id: null,
        expected: EXPECTED[kind],
        actual: EXPECTED[kind] + 1,
      });
      expect(run.report?.holds).toBe(false);
    },
  );

  // Mutation: let the job repair the balance.
  it('never repairs: the tampered value is still there after the run', async () => {
    const t = newTenant();
    await activity(t);
    const victim = await accountOf(t, 'player_available');
    const amount = () =>
      h.admin
        .query(
          `SELECT amount::int AS amount FROM balances WHERE tenant_id = $1 AND account_id = $2`,
          [t, victim],
        )
        .then((r) => r.rows[0].amount as number);
    await h.admin.query(
      `UPDATE balances SET amount = amount + 5 WHERE tenant_id = $1 AND account_id = $2`,
      [t, victim],
    );
    expect(await amount()).toBe(20);
    await h.as(t, () => h.recon.run());
    expect(await amount()).toBe(20);
  });
});

describe('INV-R5 an orphan hold and an unbalanced transaction are reported (MIO-150-28, MIO-084)', () => {
  // Mutation: do not compare reserve states with their transactions.
  it('a reserve with no reserve transaction is one reserve_state_drift for that reserve', async () => {
    const t = newTenant();
    const { player } = await activity(t);
    const wallet = await h.dbWallet(t, player);
    const orphan = uuidv7();
    await h.admin.query(
      `INSERT INTO reserves (tenant_id, id, wallet_id, amount, state) VALUES ($1, $2, $3, 4, 'reserved')`,
      [t, orphan, wallet.wallet_id],
    );
    const run = await h.as(t, () => h.recon.run());
    expect(run.status).toBe('mismatch');
    expect(run.mismatches).toHaveLength(1);
    expect(run.mismatches[0]).toMatchObject({
      kind: 'reserve_state_drift',
      reserve_id: orphan,
      account_id: null,
      transaction_id: null,
    });
  });

  it('a captured reserve whose state was set back to reserved is one reserve_state_drift', async () => {
    const t = newTenant();
    const { reserves } = await activity(t);
    await h.admin.query(`UPDATE reserves SET state = 'reserved' WHERE tenant_id = $1 AND id = $2`, [
      t,
      reserves.a,
    ]);
    const run = await h.as(t, () => h.recon.run());
    expect(run.mismatches).toHaveLength(1);
    expect(run.mismatches[0]).toMatchObject({
      kind: 'reserve_state_drift',
      reserve_id: reserves.a,
    });
  });

  // Mutation: skip the per-transaction balance check (and rely on the trigger alone).
  it('a historical transaction whose legs do not balance is one unbalanced_transaction', async () => {
    const t = newTenant();
    await activity(t);
    const issuance = await accountOf(t, 'tenant_issuance');
    const available = await accountOf(t, 'player_available');
    const tx = uuidv7();
    // Only the superuser can switch the deferred trigger off; it is always switched back on.
    try {
      await h.admin.query(`ALTER TABLE journal_transactions DISABLE TRIGGER USER`);
      await h.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER USER`);
      await h.admin.query(
        `INSERT INTO journal_transactions (tenant_id, id, operation_type, operation_id, currency, created_by)
         VALUES ($1, $2, 'spin_award', $3, 'COIN', 'tamper')`,
        [t, tx, uuidv7()],
      );
      for (const [account, direction, amount] of [
        [issuance, 'debit', 5],
        [available, 'credit', 6],
      ] as const) {
        await h.admin.query(
          `INSERT INTO ledger_entries (tenant_id, id, transaction_id, account_id, direction, amount, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'COIN')`,
          [t, uuidv7(), tx, account, direction, amount],
        );
      }
    } finally {
      await h.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER USER`);
      await h.admin.query(`ALTER TABLE journal_transactions ENABLE TRIGGER USER`);
    }
    // Keep the materialised balances in step with the legs, so the only defect is the imbalance.
    await h.admin.query(
      `UPDATE balances SET amount = amount + 5 WHERE tenant_id = $1 AND account_id = $2`,
      [t, issuance],
    );
    await h.admin.query(
      `UPDATE balances SET amount = amount + 6 WHERE tenant_id = $1 AND account_id = $2`,
      [t, available],
    );
    const run = await h.as(t, () => h.recon.run());
    expect(run.mismatches).toHaveLength(1);
    expect(run.mismatches[0]).toMatchObject({
      kind: 'unbalanced_transaction',
      transaction_id: tx,
      account_id: null,
      reserve_id: null,
    });
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
    const fired = h.faultsFired();
    h.failAt('reconciliation_scan');
    const run = await h.as(t, () => h.recon.run());
    expect(h.faultsFired()).toBe(fired + 1);
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

describe('INV-R4 the scheduled job finds every tenant without BYPASSRLS', () => {
  // Mutation: run only for the ambient tenant, or enumerate tenants through a role that bypasses RLS.
  it('runAll() with no tenant context reconciles each tenant that has a wallet and records each run', async () => {
    const clean = newTenant();
    const dirty = newTenant();
    await activity(clean);
    await activity(dirty);
    const victim = await accountOf(dirty, 'player_available');
    await h.admin.query(
      `UPDATE balances SET amount = amount + 1 WHERE tenant_id = $1 AND account_id = $2`,
      [dirty, victim],
    );
    const { rows: listed } = await h.admin.query(
      `SELECT tenant_id FROM reconciliation_tenants WHERE tenant_id IN ($1, $2)`,
      [clean, dirty],
    );
    expect(listed).toHaveLength(2); // tenants are registered when their first wallet is created
    await h.recon.runAll();
    const status = async (t: string) =>
      (
        await h.admin.query(
          `SELECT status FROM reconciliation_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [t],
        )
      ).rows[0]?.status;
    expect(await status(clean)).toBe('ok');
    expect(await status(dirty)).toBe('mismatch');
  });
});
