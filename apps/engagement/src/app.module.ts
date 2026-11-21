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
import { IngestController } from './controllers/ingest.controller';
import { ProjectionsController } from './controllers/projections.controller';
import { SpinController } from './controllers/spin.controller';
import { createDefaultRegistry } from './integrations/registry';
import {
  ADAPTER_REGISTRY,
  CLOCK,
  PLAYER_DIRECTORY,
  TENANT_CASINO_PORTS,
  TENANT_INTEGRATIONS,
  CASINO_PLAYERS,
  type TenantIntegrationPort,
} from './integrations/ports';
import {
  fetchTransport,
  staticTenantIntegrations,
  unconfiguredPlayerDirectory,
} from './integrations/static-integrations';
import { createTenantCasinoPorts } from './integrations/tenant-ports';
import { ModelModule } from './model/model.module';
import { SEEDS } from './model/repositories';
import { createSeedProvider, envSeedStore } from './model/seeds';
import { StoreModule } from './redemptions/store.module';
import { IngestionService } from './services/ingestion.service';
import { ProjectionsService } from './services/projections.service';
import { SpinCreditsService } from './services/spin-credits.service';
import { SpinService } from './services/spin.service';

@Module({
  imports: [ModelModule],
  providers: [ProjectionsService, SpinCreditsService],
  exports: [ProjectionsService, SpinCreditsService],
})
class ProjectionsModule {}

@Module({})
class EngagementModule {}

export function createAppModule(config: Config): DynamicModule {
  const bus = BusModule.register({
    service: 'engagement',
    url: config.AMQP_URL,
    bindings: ['identity.tenant.created', 'engagement.deposit.confirmed'],
    publishes: true,
    imports: [ProjectionsModule], // the handler needs ProjectionsService and SpinCreditsService
    handler: {
      inject: [ProjectionsService, SpinCreditsService],
      useFactory:
        (projections: ProjectionsService, credits: SpinCreditsService) => async (tx, event) => {
          if (event.type === 'engagement.deposit.confirmed') {
            await credits.onDepositConfirmed(tx, event);
            return;
          }
          await projections.onTenantCreated(tx, event);
        },
    },
  });
  const integrations: TenantIntegrationPort = staticTenantIntegrations(
    config.INGEST_STATIC_TENANTS,
  );
  // Dev seed only outside production: config refuses a production start without WHEEL_SEEDS.
  const seeds = createSeedProvider(envSeedStore(config.WHEEL_SEEDS ?? '{"1":"dev-wheel-seed-1"}'));
  const registry = createDefaultRegistry();
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
    controllers: [ProjectionsController, IngestController, SpinController],
    providers: [
      IngestionService,
      SpinService,
      { provide: TENANT_INTEGRATIONS, useValue: integrations },
      { provide: ADAPTER_REGISTRY, useValue: registry },
      { provide: CLOCK, useValue: { now: () => new Date() } },
      { provide: PLAYER_DIRECTORY, useValue: unconfiguredPlayerDirectory },
      {
        provide: TENANT_CASINO_PORTS,
        useValue: createTenantCasinoPorts({ integrations, registry, transport: fetchTransport }),
      },
      { provide: SEEDS, useValue: seeds },
      // CASINO_PLAYERS (the identity mapping reader) is provided by the identity client of epic L1.
      { provide: CASINO_PLAYERS, useValue: { externalPlayerId: async () => undefined } },
    ],
  };
}
