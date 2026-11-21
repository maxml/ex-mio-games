import { Module, type DynamicModule } from '@nestjs/common';
import {
  BusModule,
  BusRuntime,
  Db,
  HealthModule,
  ServiceAuthModule,
  probe,
} from '@ex-mio/service-kit';
import type { Config } from './config';
import { paymentsControllers } from './controllers';
import { LedgerModule } from './ledger.module';
import { ModelModule } from './model/model.module';
import { PAYMENTS_BINDINGS, PaymentsInboxHandler } from './services/inbox.handler';
import { LEDGER_JOBS_INTERVAL_MS, LedgerWorker } from './worker/ledger-worker';

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
      // The ONE auth entry point (D-4): tenant and principal come from a verified token (user mode)
      // or from the path of an allow-listed internal route (service mode). No resolver, no header.
      ServiceAuthModule.forService({ audience: 'payments', identityUrl: config.IDENTITY_URL }),
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
    controllers: paymentsControllers,
    providers: [
      // The worker (D-20): reconciliation and usage report on an interval, next to the outbox relay.
      { provide: LEDGER_JOBS_INTERVAL_MS, useValue: config.LEDGER_JOBS_INTERVAL_SECONDS * 1000 },
      LedgerWorker,
    ],
  };
}
