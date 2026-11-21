import { Injectable } from '@nestjs/common';
import { Db } from '@ex-mio/service-kit';

/** Advisory-lock id of "the ledger jobs are running" (per database, so no other service sees it). */
export const LEDGER_JOBS_LOCK_ID = 7_300_000_084;

type Row = Record<string, unknown>;

/**
 * The single-runner lock of the scheduled ledger jobs. Every replica of the service has a worker; the
 * lock makes sure only one of them runs a pass at a time, so a hot standby never doubles the usage
 * report or the reconciliation scan.
 */
@Injectable()
export class LedgerJobsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Run `fn` only if no other process holds the lock. The lock is a transaction-level advisory lock
   * on a connection that stays open for the whole pass and is released by the database even if this
   * process dies. Returns `ran: false` when another process holds it.
   */
  async withSingleRunner<T>(
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    return this.db.platformTx(async (tx) => {
      const rows = (await tx.query(`SELECT pg_try_advisory_xact_lock($1) AS locked`, [
        LEDGER_JOBS_LOCK_ID,
      ])) as Row[];
      if (rows[0]?.locked !== true) return { ran: false as const };
      return { ran: true as const, value: await fn() };
    });
  }
}
