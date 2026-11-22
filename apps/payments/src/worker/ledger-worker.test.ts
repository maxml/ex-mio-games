import 'reflect-metadata';
import type { DynamicModule } from '@nestjs/common';
import type { LedgerJobsResult } from '../services/ledger-jobs.service';
import { createAppModule } from '../app.module';
import { loadConfig } from '../config';
import { LEDGER_JOBS_INTERVAL_MS, LedgerWorker } from './ledger-worker';
import { ledgerReportExitCode } from './ledger-report-cli';

// Choke point: the caller of the ledger jobs (D-20). The job code itself is pinned over the real
// database in services/ledger-jobs.service.pgtest.ts; this file pins that something RUNS it: the
// worker on the interval from the environment, wired by `createAppModule`, and the CLI exit codes.

const jobs = { runOnce: jest.fn() };

describe('the worker runs the ledger jobs on a schedule', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jobs.runOnce.mockResolvedValue({ ran: true, reconciliation: [], usage: [], attention: false });
  });
  afterEach(() => jest.useRealTimers());

  // Mutation: never start the timer (or start it from a different interval).
  it('calls runOnce every interval after bootstrap, and never during boot', async () => {
    const worker = new LedgerWorker(jobs as never, 60_000);
    worker.onApplicationBootstrap();
    expect(jobs.runOnce).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(jobs.runOnce).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(jobs.runOnce).toHaveBeenCalledTimes(3);
    worker.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(300_000);
    expect(jobs.runOnce).toHaveBeenCalledTimes(3);
  });

  it('an interval of 0 turns the worker off', async () => {
    const worker = new LedgerWorker(jobs as never, 0);
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000_000);
    expect(jobs.runOnce).not.toHaveBeenCalled();
  });

  // Mutation: drop the in-process guard (two passes overlap) or let a throwing pass kill the timer.
  it('a pass still running is not started twice, and a pass that throws does not stop the schedule', async () => {
    let release!: () => void;
    jobs.runOnce.mockImplementationOnce(
      () =>
        new Promise<LedgerJobsResult>((resolve) => {
          release = () => resolve({ ran: true, reconciliation: [], usage: [], attention: false });
        }),
    );
    const worker = new LedgerWorker(jobs as never, 1000);
    const first = worker.tick();
    await worker.tick(); // overlaps: skipped
    expect(jobs.runOnce).toHaveBeenCalledTimes(1);
    release();
    await first;
    jobs.runOnce.mockRejectedValueOnce(new Error('database is down'));
    await worker.tick();
    await worker.tick();
    expect(jobs.runOnce).toHaveBeenCalledTimes(3);
  });
});

describe('createAppModule wires the worker with the interval from the environment', () => {
  const find = (mod: DynamicModule, token: unknown) =>
    (mod.providers ?? []).find(
      (p) => typeof p === 'object' && p !== null && 'provide' in p && p.provide === token,
    ) as { useValue: unknown } | undefined;

  // Mutation: drop the worker from the module, or hard-code the interval.
  it('registers LedgerWorker and takes the interval from LEDGER_JOBS_INTERVAL_SECONDS', () => {
    const env = {
      NODE_ENV: 'test',
      PORT: '4003',
      DATABASE_URL: 'postgresql://app:pw@127.0.0.1:1/payments',
      AMQP_URL: 'amqp://u:p@127.0.0.1:1',
      IDENTITY_URL: 'http://identity.test:4001',
    };
    const mod = createAppModule(loadConfig({ ...env, LEDGER_JOBS_INTERVAL_SECONDS: '90' }));
    expect(mod.providers).toContain(LedgerWorker);
    expect(find(mod, LEDGER_JOBS_INTERVAL_MS)?.useValue).toBe(90_000);
    expect(find(createAppModule(loadConfig(env)), LEDGER_JOBS_INTERVAL_MS)?.useValue).toBe(
      3_600_000,
    );
  });
});

describe('ledger-report exit codes', () => {
  const run = (status: 'ok' | 'mismatch' | 'failed') => ({
    id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a40',
    status,
    started_at: '2026-11-21T10:00:00.000Z',
    finished_at: '2026-11-21T10:00:01.000Z',
    accounts_checked: 4,
    mismatches:
      status === 'mismatch'
        ? [
            {
              kind: 'balance_drift' as const,
              account_id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a41',
              reserve_id: null,
              transaction_id: null,
              expected: 5,
              actual: 6,
            },
          ]
        : [],
    report: null,
  });
  const pass = (statuses: Array<'ok' | 'mismatch' | 'failed'>): LedgerJobsResult => ({
    ran: true,
    reconciliation: statuses.map(run),
    usage: [],
    attention: statuses.some((s) => s !== 'ok'),
  });

  // Mutation: exit 0 on a mismatch (or on a failed run).
  it('0 when everything is ok, 1 on a mismatch or a failed run, 3 when the lock is held elsewhere', () => {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    expect(ledgerReportExitCode(pass(['ok', 'ok']), log)).toBe(0);
    expect(ledgerReportExitCode(pass(['ok', 'mismatch']), log)).toBe(1);
    expect(ledgerReportExitCode(pass(['failed']), log)).toBe(1);
    expect(
      ledgerReportExitCode({ ran: false, reconciliation: [], usage: [], attention: false }, log),
    ).toBe(3);
    expect(lines.join('\n')).toMatch(/balance_drift account=0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a41/);
  });
});
