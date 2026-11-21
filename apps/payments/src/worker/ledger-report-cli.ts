import type { LedgerJobsResult } from '../services/ledger-jobs.service';

/**
 * Print one pass of the ledger jobs and return the process exit code: 0 when every tenant reconciled
 * `ok` and every usage report went through, 1 when a run found a mismatch or failed, 3 when another
 * process held the single-runner lock and nothing ran.
 */
export function ledgerReportExitCode(
  result: LedgerJobsResult,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): number {
  if (!result.ran) {
    log('ledger report: another run holds the lock, nothing was run');
    return 3;
  }
  for (const run of result.reconciliation) {
    const holds = run.report?.holds === undefined ? 'n/a' : String(run.report.holds);
    log(
      `reconciliation ${run.id} status=${run.status} accounts=${run.accounts_checked} ` +
        `mismatches=${run.mismatches.length} conservation_holds=${holds}`,
    );
    for (const m of run.mismatches) {
      log(
        `  ${m.kind} account=${m.account_id ?? '-'} reserve=${m.reserve_id ?? '-'} ` +
          `transaction=${m.transaction_id ?? '-'} expected=${m.expected ?? '-'} actual=${m.actual ?? '-'}`,
      );
    }
  }
  for (const u of result.usage) {
    log(
      `usage ${u.tenantId} period=${u.period} ${u.outcome}${u.quantity === undefined ? '' : ` quantity=${u.quantity}`}`,
    );
  }
  log(
    `ledger report: ${result.reconciliation.length} tenants, ` +
      (result.attention ? 'ATTENTION needed' : 'all ok'),
  );
  return result.attention ? 1 : 0;
}
