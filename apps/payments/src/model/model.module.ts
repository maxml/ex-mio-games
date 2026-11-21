import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE, Db } from '@ex-mio/service-kit';
import { CreditsRepository } from './credits.repository';
import { makeDataSource } from './data-source';

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      useFactory: async (): Promise<DataSource> => makeDataSource().initialize(),
    },
    Db,
    CreditsRepository,
  ],
  exports: [DATA_SOURCE, Db, CreditsRepository],
})
export class ModelModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
