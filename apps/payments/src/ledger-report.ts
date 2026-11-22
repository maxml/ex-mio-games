import 'dotenv/config';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LedgerModule } from './ledger.module';
import { ModelModule } from './model/model.module';
import { LedgerJobsService } from './services/ledger-jobs.service';
import { ledgerReportExitCode } from './worker/ledger-report-cli';

@Module({ imports: [ModelModule, LedgerModule] })
class LedgerReportModule {}

// Operator command: `node dist/ledger-report.js` (`pnpm ledger:report`). Runs one pass of the ledger
// jobs, prints the result and exits 1 on a mismatch or a failed run (it repairs nothing).
async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(LedgerReportModule, { logger: ['error'] });
  try {
    return ledgerReportExitCode(await app.get(LedgerJobsService).runOnce());
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `ledger report failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  },
);
