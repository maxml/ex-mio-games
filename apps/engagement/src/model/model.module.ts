import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE, Db } from '@ex-mio/service-kit';
import { InboundEventsRepository } from '../integrations/ports';
import { makeDataSource } from './data-source';
import {
  PgInboundEventsRepository,
  PgRulesRepository,
  PgSpinCreditsRepository,
  PgSpinsRepository,
  PgWheelsRepository,
} from './pg-repositories';
import { ProjectionsRepository } from './projections.repository';
import {
  RulesRepository,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
} from './repositories';

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      useFactory: async (): Promise<DataSource> => makeDataSource().initialize(),
    },
    Db,
    ProjectionsRepository,
    { provide: InboundEventsRepository, useClass: PgInboundEventsRepository },
    { provide: RulesRepository, useClass: PgRulesRepository },
    { provide: SpinCreditsRepository, useClass: PgSpinCreditsRepository },
    { provide: WheelsRepository, useClass: PgWheelsRepository },
    { provide: SpinsRepository, useClass: PgSpinsRepository },
  ],
  exports: [
    DATA_SOURCE,
    Db,
    ProjectionsRepository,
    InboundEventsRepository,
    RulesRepository,
    SpinCreditsRepository,
    WheelsRepository,
    SpinsRepository,
  ],
})
export class ModelModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
