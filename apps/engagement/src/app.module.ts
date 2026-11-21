import { Module, type DynamicModule } from '@nestjs/common';
import {
  BusModule,
  BusRuntime,
  checkRedisHealth,
  Db,
  HealthModule,
  probe,
} from '@ex-mio/service-kit';
import { TenancyModule } from '@ex-mio/tenancy';
import type { Config } from './config';
import { ProjectionsController } from './controllers/projections.controller';
import { ModelModule } from './model/model.module';
import { StoreModule } from './redemptions/store.module';
import { ProjectionsService } from './services/projections.service';

@Module({
  imports: [ModelModule],
  providers: [ProjectionsService],
  exports: [ProjectionsService],
})
class ProjectionsModule {}

@Module({})
class EngagementModule {}

export function createAppModule(config: Config): DynamicModule {
  const bus = BusModule.register({
    service: 'engagement',
    url: config.AMQP_URL,
    bindings: ['identity.tenant.created'],
    publishes: true,
    imports: [ProjectionsModule], // the handler needs ProjectionsService
    handler: {
      inject: [ProjectionsService],
      useFactory: (projections: ProjectionsService) => (tx, event) =>
        projections.onTenantCreated(tx, event),
    },
  });
  return {
    module: EngagementModule,
    imports: [
      TenancyModule.forRoot(),
      ModelModule,
      ProjectionsModule,
      StoreModule.register({
        paymentsUrl: config.PAYMENTS_URL,
        serviceToken: config.PAYMENTS_SERVICE_TOKEN,
        sweeperIntervalMs: config.SWEEPER_INTERVAL_MS,
      }),
      bus,
      HealthModule.register({
        imports: [ModelModule, bus],
        inject: [Db, BusRuntime],
        useFactory: (db: Db, runtime: BusRuntime) => ({
          db: () => probe(() => db.ping()),
          amqp: () => probe(async () => runtime.assertConnected()),
          // Redis is optional: omitted from the report when REDIS_URL is unset.
          ...(config.REDIS_URL
            ? {
                redis: async () => {
                  const r = await checkRedisHealth();
                  return r ?? { status: 'ok' as const };
                },
              }
            : {}),
        }),
      }),
    ],
    controllers: [ProjectionsController],
  };
}
