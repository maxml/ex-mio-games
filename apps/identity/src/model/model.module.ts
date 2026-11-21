import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE, Db } from '@ex-mio/service-kit';
import { makeDataSource } from './data-source';
import { TenantsRepository } from './tenants.repository';

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      useFactory: async (): Promise<DataSource> => makeDataSource().initialize(),
    },
    Db,
    TenantsRepository,
  ],
  exports: [DATA_SOURCE, Db, TenantsRepository],
})
export class ModelModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
