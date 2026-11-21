import { Inject, Injectable } from '@nestjs/common';
import type { ReconciliationRun } from '@ex-mio/contracts';
import { Db, reportError } from '@ex-mio/service-kit';
import { currentTenant, runWithTenant } from '@ex-mio/tenancy';
import { LEDGER_FAULTS, type LedgerFaults } from '../model/ledger.faults';
import { ReconciliationRepository, type ScanResult } from '../model/reconciliation.repository';

/**
 * Reconciliation (MIO-084): recompute every account balance from its legs, check every transaction
 * balances and every reserve agrees with its transactions, and keep a durable record of each run. It
 * only reports; it never writes to `balances`.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly repo: ReconciliationRepository,
    @Inject(LEDGER_FAULTS) private readonly faults: LedgerFaults,
  ) {}

  /** One run for the ambient tenant. A scan that dies is recorded as `failed`; it is never `ok`. */
  async run(): Promise<ReconciliationRun> {
    const { tenantId } = currentTenant();
    const startedAt = new Date();
    let scan: ScanResult | null = null;
    try {
      scan = await this.db.tenantTx(async (tx) => {
        // One snapshot for all the checks, so activity during the run cannot look like drift.
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await this.faults.hit('reconciliation_scan', tx);
        return this.repo.scan(tx, tenantId);
      });
    } catch (err) {
      // Recorded as a failed run below (never `ok`, never a throw); operators see why in the report.
      reportError(err, { phase: 'reconciliation', tenantId });
      scan = null;
    }
    const finishedAt = scan ? new Date() : null;
    const status = scan === null ? 'failed' : scan.mismatches.length === 0 ? 'ok' : 'mismatch';
    const run = {
      id: this.repo.newRunId(),
      status,
      startedAt,
      finishedAt,
      accountsChecked: scan?.accountsChecked ?? 0,
      mismatches: scan?.mismatches ?? [],
      report: scan?.report ?? null,
    } as const;
    await this.db.tenantTx((tx) =>
      this.repo.insertRun(tx, tenantId, { ...run, mismatches: [...run.mismatches] }),
    );
    return {
      id: run.id,
      status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt ? finishedAt.toISOString() : null,
      accounts_checked: run.accountsChecked,
      mismatches: [...run.mismatches],
      report: run.report,
    };
  }

  /** The latest run of the ambient tenant, flagged `stale` when it finished over two hours ago. */
  async last(): Promise<(ReconciliationRun & { stale: boolean }) | null> {
    const { tenantId } = currentTenant();
    return this.db.tenantTx((tx) => this.repo.lastRun(tx, tenantId));
  }

  /**
   * The scheduled job: no tenant context. It lists tenants from the id-only registry (no BYPASSRLS)
   * and runs each in its own tenant transaction; one tenant's failure does not stop the others.
   */
  async runAll(): Promise<ReconciliationRun[]> {
    const tenants = await this.db.platformTx((tx) => this.repo.tenants(tx));
    const runs: ReconciliationRun[] = [];
    for (const tenantId of tenants) {
      try {
        runs.push(await runWithTenant({ tenantId }, () => this.run()));
      } catch (err) {
        // The run could not even be recorded; the next scheduled run tries again.
        reportError(err, { phase: 'reconciliation', tenantId });
      }
    }
    return runs;
  }
}
