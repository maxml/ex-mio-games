import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import type { Client } from 'pg';
import { uuidv7 } from '@ex-mio/contracts';
import { DATA_SOURCE, type RedisCache } from '@ex-mio/service-kit';
import { runWithTenant, TenancyModule, withTenantTransaction } from '@ex-mio/tenancy';
import type { EntityManager } from 'typeorm';
import { BalanceService } from '../services/balance.service';
import { BillingService } from '../services/billing.service';
import { LedgerService } from '../services/ledger.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { UsageService } from '../services/usage.service';
import { LedgerModule } from '../ledger.module';
import { BALANCE_CACHE } from '../services/balance.service';
import { LEDGER_FAULTS, type FaultPoint } from '../model/ledger.faults';
import { makeDataSource } from '../model/data-source';
import { connectAs } from './pg';

/** In-memory `RedisCache` whose failures can be switched on. Records every call. */
export class FakeCache implements RedisCache {
  readonly store = new Map<string, string>();
  readonly calls: string[] = [];
  down = false;

  private guard(call: string): void {
    this.calls.push(call);
    if (this.down) throw new Error('redis down');
  }
  async get(key: string) {
    this.guard(`get ${key}`);
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.guard(`set ${key}`);
    this.store.set(key, value);
  }
  async del(key: string) {
    this.guard(`del ${key}`);
    this.store.delete(key);
  }
  async ping() {
    return this.down ? ('down' as const) : ('ok' as const);
  }
  client(): never {
    throw new Error('not used in tests');
  }
  async disconnect() {}
}

export interface Harness {
  ledger: LedgerService;
  balances: BalanceService;
  recon: ReconciliationService;
  usage: UsageService;
  billing: BillingService;
  cache: FakeCache;
  dataSource: DataSource;
  /** Superuser connection to the same database: inspect or tamper, bypassing RLS. */
  admin: Client;
  /** Make the next time the ledger reaches `point` throw. Cleared after it fires once. */
  failAt(point: FaultPoint | null): void;
  /** Run `fn` as the service identity `engagement` acting in `tenantId`. */
  as<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  /** Apply one event to the usage meters the way the inbox consumer would (one tenant transaction). */
  deliver(tenantId: string, fn: (manager: EntityManager) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

/**
 * Builds the payments services against the real Postgres as the runtime role. The tests choose
 * nothing else: wiring, repositories and the fault hook are the implementation's.
 */
export async function openHarness(): Promise<Harness> {
  process.env.DATABASE_URL ??=
    'postgresql://payments_app:payments_app-dev@localhost:54329/payments';
  const dataSource = await makeDataSource().initialize();
  let armed: FaultPoint | null = null;
  const cache = new FakeCache();

  const mod = await Test.createTestingModule({
    imports: [TenancyModule.forRoot(), LedgerModule],
  })
    .overrideProvider(DATA_SOURCE)
    .useValue(dataSource)
    .overrideProvider(BALANCE_CACHE)
    .useValue(cache)
    .overrideProvider(LEDGER_FAULTS)
    .useValue({
      hit(point: FaultPoint) {
        if (armed === point) {
          armed = null;
          throw new Error(`injected fault at ${point}`);
        }
      },
    })
    .compile();
  await mod.init();
  const admin = await connectAs('postgres');

  return {
    ledger: mod.get(LedgerService),
    balances: mod.get(BalanceService),
    recon: mod.get(ReconciliationService),
    usage: mod.get(UsageService),
    billing: mod.get(BillingService),
    cache,
    dataSource,
    admin,
    failAt: (p) => {
      armed = p;
    },
    as: (tenantId, fn) => runWithTenant({ tenantId, principalId: 'engagement' }, fn),
    deliver: (tenantId, fn) =>
      runWithTenant({ tenantId, principalId: 'engagement' }, () =>
        withTenantTransaction(dataSource, fn),
      ),
    close: async () => {
      await admin.end();
      await mod.close();
      if (dataSource.isInitialized) await dataSource.destroy();
    },
  };
}

export const newTenant = (): string => uuidv7();
export const newPlayer = (): string => uuidv7();
export const key = (prefix: string): string => `${prefix}-${uuidv7()}`;
