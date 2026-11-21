import { Module, type DynamicModule } from '@nestjs/common';
import { BusModule, BusRuntime, Db, HealthModule, probe } from '@ex-mio/service-kit';
import { TenancyModule } from '@ex-mio/tenancy';
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
    controllers: [CreditsController],
    providers: [CreditsService],
  };
}
