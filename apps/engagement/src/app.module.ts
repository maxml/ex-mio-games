import { Module, type DynamicModule } from '@nestjs/common';
import {
  BusModule,
  BusRuntime,
  checkRedisHealth,
  Db,
  HealthModule,
  probe,
  ServiceAuthModule,
} from '@ex-mio/service-kit';
import type { Config } from './config';
import { IngestController } from './controllers/ingest.controller';
import { ProjectionsController } from './controllers/projections.controller';
import { SpinController } from './controllers/spin.controller';
import { IdentityHttpClient, ServiceTokenSource } from './integrations/identity-client';
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
  staticThenIdentity,
  staticThenIdentityPlayers,
} from './integrations/static-integrations';
import {
  createCasinoPlayerPort,
  createRewardRequestBuilder,
  createTenantCasinoPorts,
} from './integrations/tenant-ports';
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
  // Identity is the source of the player mapping and of the tenants' casino credentials (X-1, X-7,
  // X-8); this service calls it with a client-credentials service token (D-4, D-14).
  const tokens = new ServiceTokenSource({
    identityUrl: config.IDENTITY_URL,
    clientId: 'engagement',
    clientSecret: config.SERVICE_CLIENT_SECRET,
  });
  const identity = new IdentityHttpClient(config.IDENTITY_URL, tokens);
  const casinoPlayers = createCasinoPlayerPort({ identity });
  // The static `INGEST_STATIC_TENANTS` stand-in is for development only (config refuses it in production).
  const statics = config.INGEST_STATIC_TENANTS
    ? staticTenantIntegrations(config.INGEST_STATIC_TENANTS)
    : undefined;
  const integrations: TenantIntegrationPort = statics
    ? staticThenIdentity(statics, identity)
    : identity;
  const players = statics ? staticThenIdentityPlayers(statics, identity) : identity;
  // Dev seed only outside production: config refuses a production start without WHEEL_SEEDS.
  const seeds = createSeedProvider(envSeedStore(config.WHEEL_SEEDS ?? '{"1":"dev-wheel-seed-1"}'));
  const registry = createDefaultRegistry();
  // The REAL L3 adapters, per tenant and environment, shared by ingest's casino port and the store (D-20).
  const casinoPorts = createTenantCasinoPorts({
    integrations,
    registry,
    transport: fetchTransport,
  });
  return {
    module: EngagementModule,
    imports: [
      // The one auth entry point (D-4): the tenant and the principal come from a verified token claim.
      // It must come first: global guards run in module registration order.
      ServiceAuthModule.forService({ audience: 'engagement', identityUrl: config.IDENTITY_URL }),
      ModelModule,
      ProjectionsModule,
      StoreModule.register({
        paymentsUrl: config.PAYMENTS_URL,
        paymentsToken: () => tokens.tokenFor('payments'),
        sweeperIntervalMs: config.SWEEPER_INTERVAL_MS,
        ports: casinoPorts,
        requests: createRewardRequestBuilder({ players: casinoPlayers }),
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
      // X-1: ingest resolves the casino's player id through identity before the outbox write.
      { provide: PLAYER_DIRECTORY, useValue: players },
      { provide: TENANT_CASINO_PORTS, useValue: casinoPorts },
      { provide: SEEDS, useValue: seeds },
      // X-8: the reverse mapping (internal player -> the casino's id), read per order.
      { provide: CASINO_PLAYERS, useValue: casinoPlayers },
    ],
  };
}
