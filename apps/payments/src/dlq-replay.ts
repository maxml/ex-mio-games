import 'dotenv/config';
import 'reflect-metadata';
import { runDlqCli } from '@ex-mio/service-kit';
import { makeDataSource } from './model/data-source';

// Operator command: `node dist/dlq-replay.js [--dry-run] [--limit N] [--outbox]`.
void runDlqCli({ service: 'payments', dataSource: makeDataSource }).then((code) =>
  process.exit(code),
);
