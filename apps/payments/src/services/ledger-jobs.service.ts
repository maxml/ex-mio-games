import { Injectable } from '@nestjs/common';
import type { ReconciliationRun } from '@ex-mio/contracts';
import { Db, reportError } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import { LedgerJobsRepository } from '../model/ledger-jobs.repository';
import { ReconciliationRepository } from '../model/reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';
import { UsageService } from './usage.service';

export interface UsageJobResult {
  tenantId: string;
  period: string;
  outcome: 'reported' | 'no_subscription' | 'failed';
  quantity?: number;
}

export interface LedgerJobsResult {
  /** False when another process held the single-runner lock; nothing ran. */
  ran: boolean;
  reconciliation: ReconciliationRun[];
  usage: UsageJobResult[];
  /** True when any run is not `ok` (a mismatch or a failed scan). The CLI exits non-zero on it. */
  attention: boolean;
}

/** The calendar month before `now`, UTC, as `YYYY-MM`: the period whose usage is complete. */
export function previousPeriod(now: Date): string {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return first.toISOString().slice(0, 7);
}

/**
 * The scheduled ledger jobs (MIO-084, MIO-095): reconciliation of every tenant and the usage report
 * of the last complete month. One pass is `runOnce()`; the worker calls it on an interval and the
 * `ledger-report` command calls it once. Both go through the same single-runner lock. Neither repairs
 * anything: a mismatch is reported (error reporter, so an alert fires) and recorded in the run record
 * that the platform admin route reads.
 */
@Injectable()
export class LedgerJobsService {
  constructor(
    private readonly db: Db,
    private readonly lock: LedgerJobsRepository,
    private readonly recon: ReconciliationService,
    private readonly reconRepo: ReconciliationRepository,
    private readonly usage: UsageService,
  ) {}

  async runOnce(now: Date = new Date()): Promise<LedgerJobsResult> {
    const outcome = await this.lock.withSingleRunner(async () => {
      const reconciliation = await this.recon.runAll();
      for (const run of reconciliation) {
        if (run.status !== 'ok') {
          reportError(new Error(`ledger reconciliation ${run.status}`), {
            phase: 'reconciliation',
            runId: run.id,
            mismatches: run.mismatches.length,
          });
        }
      }
      const usage = await this.reportUsage(previousPeriod(now));
      return { reconciliation, usage };
    });
    if (!outcome.ran) return { ran: false, reconciliation: [], usage: [], attention: false };
    const { reconciliation, usage } = outcome.value;
    return {
      ran: true,
      reconciliation,
      usage,
      attention:
        reconciliation.some((r) => r.status !== 'ok') || usage.some((u) => u.outcome === 'failed'),
    };
  }

  private async reportUsage(period: string): Promise<UsageJobResult[]> {
    const tenants = await this.db.platformTx((tx) => this.reconRepo.tenants(tx));
    const results: UsageJobResult[] = [];
    for (const tenantId of tenants) {
      try {
        const sent = await runWithTenant({ tenantId }, () => this.usage.reportDue(period));
        results.push(
          sent
            ? { tenantId, period, outcome: 'reported', quantity: sent.quantity }
            : { tenantId, period, outcome: 'no_subscription' },
        );
      } catch (err) {
        // One tenant's failure (a provider outage, say) does not stop the others; the next pass retries
        // under the same provider idempotency key.
        reportError(err, { phase: 'usage_report', tenantId, period });
        results.push({ tenantId, period, outcome: 'failed' });
      }
    }
    return results;
  }
}
