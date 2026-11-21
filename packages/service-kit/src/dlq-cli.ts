import { connectAmqp, replayDeadLetters, unparkOutbox } from '@ex-mio/bus';
import type { DataSource } from 'typeorm';

export interface DlqCliOptions {
  /** The service whose `<service>.dlq` is replayed. */
  service: string;
  /** Opens the service's database; only needed for `--outbox`. */
  dataSource?: () => DataSource;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

const USAGE = `usage: node dist/dlq-replay.js [--dry-run] [--limit N] [--outbox]
  (default)   move every message from <service>.dlq back to <service>.events
  --dry-run   only print how many messages wait
  --limit N   replay at most N messages
  --outbox    also give parked outbox rows (events nobody consumed) a fresh start`;

/**
 * Body of a service's `dlq-replay.js` entry point: the operator's way to re-drive
 * dead-lettered messages once the cause is fixed. Needs `AMQP_URL` (and
 * `DATABASE_URL` for `--outbox`). Exit 0 = done, 1 = failed, 2 = bad arguments.
 */
export async function runDlqCli(options: DlqCliOptions): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const dryRun = argv.includes('--dry-run');
  const outbox = argv.includes('--outbox');
  const limitAt = argv.indexOf('--limit');
  const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : undefined;
  const known = new Set(['--dry-run', '--outbox', '--limit']);
  const stray = argv.filter(
    (a, i) => !known.has(a) && !(limitAt >= 0 && i === limitAt + 1 && /^\d+$/.test(a)),
  );
  if (stray.length > 0 || (limit !== undefined && !(Number.isInteger(limit) && limit > 0))) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!env.AMQP_URL) {
    process.stderr.write('AMQP_URL is required\n');
    return 1;
  }
  let ds: DataSource | undefined;
  try {
    const connection = await connectAmqp(env.AMQP_URL, { retries: 3, delayMs: 500 });
    try {
      const channel = await connection.createConfirmChannel();
      const result = await replayDeadLetters(channel, options.service, { limit, dryRun });
      log(
        dryRun
          ? `${options.service}.dlq: ${result.depth} message(s) waiting`
          : `${options.service}.dlq: ${result.depth} waiting, ${result.replayed} replayed`,
      );
    } finally {
      await connection.close().catch(() => undefined);
    }
    if (outbox && !dryRun) {
      if (!options.dataSource) throw new Error('--outbox needs a database');
      ds = options.dataSource();
      await ds.initialize();
      log(`outbox: ${await unparkOutbox(ds)} parked row(s) released`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `dlq-replay failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    if (ds?.isInitialized) await ds.destroy();
  }
}
