import { Module, type DynamicModule } from '@nestjs/common';
import { BusModule, BusRuntime, Db, HealthModule, probe } from '@ex-mio/service-kit';
import { TenancyModule } from '@ex-mio/tenancy';
import type { Config } from './config';
import { BalanceController } from './controllers/balance.controller';
import { BillingController } from './controllers/billing.controller';
import { CoinsController } from './controllers/coins.controller';
import { ActingTenantGuard, PrincipalGuard } from './controllers/principal.guard';
import { SERVICE_TOKENS, ServiceTokenGuard } from './controllers/service-token.guard';
import { LedgerModule } from './ledger.module';
import { ModelModule } from './model/model.module';
import { PAYMENTS_BINDINGS, PaymentsInboxHandler } from './services/inbox.handler';

@Module({})
class PaymentsModule {}

export function createAppModule(config: Config): DynamicModule {
  const bus = BusModule.register({
    service: 'payments',
    url: config.AMQP_URL,
    // The spin credit (D-1) and its own coin events, which refresh the Redis balance projection.
    bindings: PAYMENTS_BINDINGS,
    publishes: true,
    imports: [LedgerModule],
    handler: {
      inject: [PaymentsInboxHandler],
      useFactory: (handler: PaymentsInboxHandler) => (tx, event) => handler.handle(tx, event),
    },
  });
  return {
    module: PaymentsModule,
    imports: [
      TenancyModule.forRoot(),
      ModelModule,
      LedgerModule,
      bus,
      HealthModule.register({
        imports: [ModelModule, bus],
        inject: [Db, BusRuntime],
        useFactory: (db: Db, runtime: BusRuntime) => ({
          db: () => probe(() => db.ping()),
          amqp: () => probe(async () => runtime.assertConnected()),
        }),
      }),
    ],
    controllers: [CoinsController, BalanceController, BillingController],
    providers: [
      { provide: SERVICE_TOKENS, useValue: config.SERVICE_TOKENS },
      ServiceTokenGuard,
      ActingTenantGuard,
      PrincipalGuard,
    ],
  };
}
