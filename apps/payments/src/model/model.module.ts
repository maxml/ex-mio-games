import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE, Db } from '@ex-mio/service-kit';
import { BillingRepository } from './billing.repository';
import { makeDataSource } from './data-source';
import { LedgerJobsRepository } from './ledger-jobs.repository';
import { LedgerRepository } from './ledger.repository';
import { LEDGER_FAULTS, NO_FAULTS } from './ledger.faults';
import { ReconciliationRepository } from './reconciliation.repository';
import { UsageRepository } from './usage.repository';

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      useFactory: async (): Promise<DataSource> => makeDataSource().initialize(),
    },
    Db,
    { provide: LEDGER_FAULTS, useValue: NO_FAULTS },
    LedgerRepository,
    LedgerJobsRepository,
    UsageRepository,
    BillingRepository,
    ReconciliationRepository,
  ],
  exports: [
    DATA_SOURCE,
    Db,
    LEDGER_FAULTS,
    LedgerRepository,
    LedgerJobsRepository,
    UsageRepository,
    BillingRepository,
    ReconciliationRepository,
  ],
})
export class ModelModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
