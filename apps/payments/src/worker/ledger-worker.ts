import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { reportError } from '@ex-mio/service-kit';
import { LedgerJobsService } from '../services/ledger-jobs.service';

/** Injection token of the pass interval in milliseconds (0 turns the worker off). */
export const LEDGER_JOBS_INTERVAL_MS = Symbol('LEDGER_JOBS_INTERVAL_MS');

/**
 * The payments worker: runs the ledger jobs (reconciliation of every tenant, then the usage report of
 * the last complete month) on an interval taken from `LEDGER_JOBS_INTERVAL_SECONDS`. It lives in the
 * service process, next to the outbox relay. Replicas are safe: `LedgerJobsService` takes a database
 * lock, so only one pass runs at a time. A pass that throws is reported and the next one runs on time.
 * The first pass is one interval after start, never during boot.
 */
@Injectable()
export class LedgerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly jobs: LedgerJobsService,
    @Inject(LEDGER_JOBS_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass; a pass still running in this process is not started twice. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.jobs.runOnce();
    } catch (err) {
      reportError(err, { phase: 'ledger_jobs' });
    } finally {
      this.running = false;
    }
  }
}
