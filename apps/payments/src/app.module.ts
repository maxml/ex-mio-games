import { Module, type DynamicModule } from '@nestjs/common';
import { BusModule, BusRuntime, Db, HealthModule, probe } from '@ex-mio/service-kit';
import { headerTenantAllowed, TenancyModule } from '@ex-mio/tenancy';
import type { Config } from './config';
import { CreditsController } from './controllers/credits.controller';
import { ModelModule } from './model/model.module';
import { CreditsService } from './services/credits.service';

@Module({})
class PaymentsModule {}

export function createAppModule(config: Config): DynamicModule {
  const bus = BusModule.register({
    service: 'payments',
    url: config.AMQP_URL,
    bindings: [], // payments publishes coin events and consumes none yet
    publishes: true,
  });
  return {
    module: PaymentsModule,
    imports: [
      TenancyModule.forRoot(),
      ModelModule,
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
    // The credit endpoint is a wiring demo behind the header tenant placeholder. Coins
    // are credited only by the payments consumer (decision D-1), so where the header
    // resolver is refused (production) the route does not exist at all.
    controllers: headerTenantAllowed() ? [CreditsController] : [],
    providers: [CreditsService],
  };
}
