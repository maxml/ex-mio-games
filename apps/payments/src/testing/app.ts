import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { BusRuntime, DATA_SOURCE } from '@ex-mio/service-kit';
import { createAppModule } from '../app.module';
import { loadConfig } from '../config';
import { SERVICE_TOKENS } from '../controllers/service-token.guard';
import { BALANCE_CACHE, BalanceService } from '../services/balance.service';
import { BillingService } from '../services/billing.service';
import { LedgerService } from '../services/ledger.service';
import { FakePaymentProvider } from '../services/providers/fake.provider';
import { PAYMENT_PROVIDER } from '../services/providers/payment-provider';
import { FakeCache } from './harness';

export interface BuiltApp {
  app: NestFastifyApplication;
  /** Every route the real application module registered, as `METHOD path`. */
  routes: string[];
  provider: FakePaymentProvider;
  /** Throws when the database is touched: a path that must not reach it can prove so. */
  dbTouched: jest.Mock;
}

type Mockable = { ledger?: object; balances?: object; billing?: object };

/**
 * The REAL application module (`createAppModule`), with only the outside world replaced: the database
 * (a stub that records any use and then fails), the broker, Redis, the provider, the service tokens.
 * Services named in `mock` are replaced too. The route table is whatever the module registers, so a
 * route nobody remembered to delete (the foundation's `POST /v1/credits`) shows up here.
 */
export async function buildApp(
  mock: Mockable = {},
  env: Record<string, string> = {},
): Promise<BuiltApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '4003',
    DATABASE_URL: 'postgresql://app:pw@127.0.0.1:1/payments',
    AMQP_URL: 'amqp://u:p@127.0.0.1:1',
    ...env,
  });
  const dbTouched = jest.fn();
  const dataSource = {
    isInitialized: true,
    destroy: async () => undefined,
    query: async () => dbTouched('query') as never,
    transaction: async () => dbTouched('transaction') as never,
    createQueryRunner: () => dbTouched('createQueryRunner') as never,
  };
  dbTouched.mockImplementation((what: string) => {
    throw new Error(`database touched (${what})`);
  });
  const provider = new FakePaymentProvider({ webhookSecret: 'whsec_test_secret' });

  let builder = Test.createTestingModule({ imports: [createAppModule(config)] })
    .overrideProvider(DATA_SOURCE)
    .useValue(dataSource)
    .overrideProvider(BusRuntime)
    .useValue({ isConnected: () => true, assertConnected: () => undefined })
    .overrideProvider(BALANCE_CACHE)
    .useValue(new FakeCache())
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(provider)
    .overrideProvider(SERVICE_TOKENS)
    .useValue({ engagement: 'engagement-secret' });
  if (mock.ledger) builder = builder.overrideProvider(LedgerService).useValue(mock.ledger);
  if (mock.balances) builder = builder.overrideProvider(BalanceService).useValue(mock.balances);
  if (mock.billing) builder = builder.overrideProvider(BillingService).useValue(mock.billing);
  const mod = await builder.compile();

  const adapter = new FastifyAdapter();
  const routes: string[] = [];
  adapter.getInstance().addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method !== 'HEAD' && method !== 'OPTIONS') routes.push(`${method} ${r.url}`);
    }
  });
  const app = mod.createNestApplication<NestFastifyApplication>(adapter, { rawBody: true });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, routes, provider, dbTouched };
}
