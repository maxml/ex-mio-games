import { Module, type DynamicModule } from '@nestjs/common';
import { BusModule, BusRuntime, Db, HealthModule, probe } from '@ex-mio/service-kit';
import { TenancyModule } from '@ex-mio/tenancy';
import type { Config } from './config';
import { PLATFORM_ADMIN_TOKEN, PlatformAdminGuard } from './controllers/platform-admin.guard';
import { TenantsController } from './controllers/tenants.controller';
import { ModelModule } from './model/model.module';
import { TenantsService } from './services/tenants.service';

@Module({})
class IdentityModule {}

export function createAppModule(config: Config): DynamicModule {
  const bus = BusModule.register({
    service: 'identity',
    url: config.AMQP_URL,
    bindings: [], // identity publishes tenant events and consumes none
    publishes: true,
  });
  return {
    module: IdentityModule,
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
    controllers: [TenantsController],
    providers: [
      TenantsService,
      PlatformAdminGuard,
      { provide: PLATFORM_ADMIN_TOKEN, useValue: config.PLATFORM_ADMIN_TOKEN },
    ],
  };
}
