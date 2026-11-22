import { Injectable } from '@nestjs/common';
import { uuidv7, type ConservationReport, type ReconciliationRun } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

type Row = Record<string, unknown>;
export type Mismatch = ReconciliationRun['mismatches'][number];

export interface ScanResult {
  accountsChecked: number;
  mismatches: Mismatch[];
  report: ConservationReport;
}

const none = { account_id: null, reserve_id: null, transaction_id: null } as const;

/** Read-only scan of one tenant's ledger, and the durable record of each run. */
@Injectable()
export class ReconciliationRepository {
  /** Make the current transaction a repeatable-read snapshot (first statement of the transaction). */
  async useSnapshot(tx: Tx): Promise<void> {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  }

  /** Run inside ONE repeatable-read transaction, so the checks agree with each other under load. */
  async scan(tx: Tx, tenantId: string): Promise<ScanResult> {
    const mismatches: Mismatch[] = [];

    // 1. Every materialised balance equals the sum of its legs.
    const accounts = (await tx.query(
      `SELECT a.id AS account_id, b.amount::text AS actual,
              coalesce(sum(CASE WHEN (a.kind = 'tenant_issuance') = (e.direction = 'debit')
                                THEN e.amount ELSE -e.amount END), 0)::text AS expected
         FROM accounts a
         LEFT JOIN ledger_entries e ON e.tenant_id = a.tenant_id AND e.account_id = a.id
         LEFT JOIN balances b ON b.tenant_id = a.tenant_id AND b.account_id = a.id
        WHERE a.tenant_id = $1
        GROUP BY a.id, b.amount ORDER BY a.id`,
      [tenantId],
    )) as Row[];
    for (const r of accounts) {
      const expected = Number(r.expected);
      const actual = r.actual === null ? null : Number(r.actual);
      if (actual !== expected) {
        mismatches.push({
          ...none,
          kind: 'balance_drift',
          account_id: r.account_id as string,
          expected,
          actual,
        });
      }
    }

    // 2. Every journal transaction balances and has at least two legs.
    const unbalanced = (await tx.query(
      `SELECT t.id AS transaction_id,
              coalesce(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)::text AS debits,
              coalesce(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0)::text AS credits
         FROM journal_transactions t
         LEFT JOIN ledger_entries e ON e.tenant_id = t.tenant_id AND e.transaction_id = t.id
        WHERE t.tenant_id = $1
        GROUP BY t.id
       HAVING count(e.id) < 2
           OR coalesce(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)
              <> coalesce(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0)
        ORDER BY t.id`,
      [tenantId],
    )) as Row[];
    for (const r of unbalanced) {
      mismatches.push({
        ...none,
        kind: 'unbalanced_transaction',
        transaction_id: r.transaction_id as string,
        expected: Number(r.debits),
        actual: Number(r.credits),
      });
    }

    // 3. Every reserve's state agrees with the transactions of its operation id.
    const reserves = (await tx.query(
      `SELECT r.id AS reserve_id, r.state,
              coalesce(bool_or(j.operation_type = 'reserve'), false) AS has_reserve,
              coalesce(bool_or(j.operation_type = 'capture'), false) AS has_capture,
              coalesce(bool_or(j.operation_type = 'release'), false) AS has_release,
              coalesce(bool_or(j.operation_type = 'refund'), false) AS has_refund
         FROM reserves r
         LEFT JOIN journal_transactions j ON j.tenant_id = r.tenant_id AND j.operation_id = r.id
              AND j.operation_type IN ('reserve', 'capture', 'release', 'refund')
        WHERE r.tenant_id = $1
        GROUP BY r.id, r.state ORDER BY r.id`,
      [tenantId],
    )) as Row[];
    for (const r of reserves) {
      const sound =
        r.has_reserve === true &&
        !(r.has_capture === true && r.has_release === true) &&
        !(r.has_refund === true && r.has_capture !== true);
      const derived = r.has_refund
        ? 'refunded'
        : r.has_capture
          ? 'captured'
          : r.has_release
            ? 'released'
            : 'reserved';
      if (!sound || derived !== r.state) {
        mismatches.push({
          ...none,
          kind: 'reserve_state_drift',
          reserve_id: r.reserve_id as string,
          expected: null,
          actual: null,
        });
      }
    }

    return {
      accountsChecked: accounts.length,
      mismatches,
      report: await this.report(tx, tenantId),
    };
  }

  /**
   * The report shows the PRODUCTION figures; its `holds` is true only when the conservation identity
   * holds in BOTH environments, so a sandbox ledger that drifts is not hidden, and sandbox coins are
   * not mixed into the production numbers (X-2).
   */
  private async report(tx: Tx, tenantId: string): Promise<ConservationReport> {
    const production = await this.figures(tx, tenantId, false);
    const sandbox = await this.figures(tx, tenantId, true);
    return { ...production, holds: production.holds && sandbox.holds };
  }

  /** issued = available + held + redeemed, and redeemed = captured - refunded, for one environment. */
  private async figures(tx: Tx, tenantId: string, sandbox: boolean): Promise<ConservationReport> {
    const kinds = (await tx.query(
      `SELECT a.kind, coalesce(sum(b.amount), 0)::text AS total
         FROM accounts a JOIN balances b ON b.tenant_id = a.tenant_id AND b.account_id = a.id
        WHERE a.tenant_id = $1 AND a.sandbox = $2 GROUP BY a.kind`,
      [tenantId, sandbox],
    )) as Row[];
    const balance = (kind: string) => Number(kinds.find((r) => r.kind === kind)?.total ?? 0);
    const ops = (await tx.query(
      `SELECT j.operation_type AS type, coalesce(sum(e.amount), 0)::text AS total
         FROM journal_transactions j
         JOIN ledger_entries e ON e.tenant_id = j.tenant_id AND e.transaction_id = j.id AND e.direction = 'debit'
         JOIN accounts a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
        WHERE j.tenant_id = $1 AND a.sandbox = $2 AND j.operation_type IN ('capture', 'release', 'refund')
        GROUP BY j.operation_type`,
      [tenantId, sandbox],
    )) as Row[];
    const total = (type: string) => Number(ops.find((r) => r.type === type)?.total ?? 0);

    const issued = balance('tenant_issuance');
    const available = balance('player_available');
    const held = balance('player_held');
    const redeemed = balance('tenant_redeemed');
    const captured = total('capture');
    const refunded = total('refund');
    return {
      issued,
      available,
      held,
      captured,
      released: total('release'),
      refunded,
      holds: issued === available + held + redeemed && redeemed === captured - refunded,
    };
  }

  async insertRun(
    tx: Tx,
    tenantId: string,
    run: {
      id: string;
      status: 'ok' | 'mismatch' | 'failed';
      startedAt: Date;
      finishedAt: Date | null;
      accountsChecked: number;
      mismatches: Mismatch[];
      report: ConservationReport | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO reconciliation_runs
         (tenant_id, id, status, started_at, finished_at, accounts_checked, mismatches, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        run.id,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.accountsChecked,
        JSON.stringify(run.mismatches),
        run.report ? JSON.stringify(run.report) : null,
      ],
    );
  }

  async lastRun(
    tx: Tx,
    tenantId: string,
  ): Promise<(ReconciliationRun & { stale: boolean }) | null> {
    const rows = (await tx.query(
      `SELECT id, status, started_at, finished_at, accounts_checked, mismatches, report,
              coalesce(finished_at, started_at) < now() - interval '2 hours' AS stale
         FROM reconciliation_runs WHERE tenant_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      [tenantId],
    )) as Row[];
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id as string,
      status: r.status as ReconciliationRun['status'],
      started_at: (r.started_at as Date).toISOString(),
      finished_at: r.finished_at ? (r.finished_at as Date).toISOString() : null,
      accounts_checked: Number(r.accounts_checked),
      mismatches: r.mismatches as Mismatch[],
      report: (r.report as ConservationReport | null) ?? null,
      stale: r.stale === true,
    };
  }

  /** Tenants that ever created a wallet (the id-only registry; no BYPASSRLS needed). */
  async tenants(tx: Tx): Promise<string[]> {
    const rows = (await tx.query(
      `SELECT tenant_id FROM reconciliation_tenants ORDER BY tenant_id`,
    )) as Row[];
    return rows.map((r) => r.tenant_id as string);
  }

  newRunId(): string {
    return uuidv7();
  }
}
