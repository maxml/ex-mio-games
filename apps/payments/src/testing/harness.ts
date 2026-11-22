import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { DataSource, EntityManager } from 'typeorm';
import type { Client } from 'pg';
import { InboxConsumer, type InboxOptions, type ProcessOutcome } from '@ex-mio/bus';
import { createEvent, uuidv7, type EventEnvelope } from '@ex-mio/contracts';
import { DATA_SOURCE, type RedisCache } from '@ex-mio/service-kit';
import { runWithTenant, withTenantTransaction } from '@ex-mio/tenancy';
import { BalanceService, BALANCE_CACHE } from '../services/balance.service';
import { BillingService } from '../services/billing.service';
import { PaymentsInboxHandler } from '../services/inbox.handler';
import { LedgerJobsService } from '../services/ledger-jobs.service';
import { LedgerService } from '../services/ledger.service';
import { FakePaymentProvider } from '../services/providers/fake.provider';
import { PAYMENT_PROVIDER } from '../services/providers/payment-provider';
import { ReconciliationService } from '../services/reconciliation.service';
import { UsageService } from '../services/usage.service';
import { LedgerModule } from '../ledger.module';
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

export interface Delivery {
  outcome: ProcessOutcome;
  acked: boolean;
  /** Settled without requeue: the message went to the dead-letter queue. */
  deadLettered: boolean;
  /** Settled with requeue. */
  requeued: boolean;
  errors: unknown[];
}

export interface DbWallet {
  wallet_id: string;
  available: number;
  held: number;
}

export interface OpenOptions {
  /** Max connections of the runtime pool. The default harness uses the service default (10). */
  poolMax?: number;
  /** Record every SQL statement the runtime pool sends (for the single-connection variant). */
  captureSql?: boolean;
}

export interface Harness {
  ledger: LedgerService;
  balances: BalanceService;
  recon: ReconciliationService;
  /** The scheduled ledger jobs (D-20): what the worker and `ledger-report` run. */
  jobs: LedgerJobsService;
  usage: UsageService;
  billing: BillingService;
  inbox: PaymentsInboxHandler;
  /** The fake payment provider the services were wired with; tests read what it recorded. */
  provider: FakePaymentProvider;
  cache: FakeCache;
  dataSource: DataSource;
  /** Superuser connection to the same database: inspect or tamper, bypassing RLS. */
  admin: Client;
  /** Every SQL statement sent through the runtime pool (only with `captureSql`). */
  sql: string[];
  /** Max connections the runtime pool was really configured with. */
  poolMax(): number;
  /**
   * Make the next time the code reaches `point` throw. The hook is driven HERE: before it throws it
   * proves, through the very transaction the code passed in, that the write which precedes the point
   * is visible there but not committed. A misplaced hook fails the test ("misplaced fault hook").
   * `transient` gives the error SQLSTATE 40001 (a serialization failure).
   */
  failAt(point: FaultPoint | null, opts?: { transient?: boolean }): void;
  /** How many armed faults have fired. */
  faultsFired(): number;
  /** Run `fn` as the service identity `engagement` acting in `tenantId`. */
  as<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  /** Run `fn` in one tenant transaction (what the inbox consumer gives a handler). */
  deliver(tenantId: string, fn: (manager: EntityManager) => Promise<void>): Promise<void>;
  /**
   * Deliver `event` through the REAL `InboxConsumer` with the payments handler, consumer name
   * `payments`, as the runtime role. `instance: 2` uses a second DataSource (a second pool).
   */
  consume(event: EventEnvelope, opts?: { instance?: 1 | 2 }): Promise<Delivery>;
  /** Credit `amount` coins to `player` the only way coins can arrive: a `spin.completed` event. */
  fund(tenantId: string, player: string, amount: number): Promise<{ spinId: string }>;
  /** A player's wallet read straight from the tables (never through BalanceService or the cache). */
  dbWallet(tenantId: string, player: string): Promise<DbWallet>; // the PRODUCTION wallet
  dbWalletIn(tenantId: string, player: string, sandbox: boolean): Promise<DbWallet>;
  dbWalletById(tenantId: string, walletId: string): Promise<DbWallet>;
  /** Sign a webhook body the way the fake provider does. */
  sign(rawBody: string): string;
  close(): Promise<void>;
}

type Rows = Record<string, unknown>[];
// amqplib's own types, reached through the bus package so this app needs no amqplib dependency.
type Channel = InboxOptions['channel'];
type ConsumeMessage = Parameters<InboxConsumer['onMessage']>[0];

const SNAPSHOT_SQL = `
  SELECT (SELECT count(*)::int FROM inbox WHERE tenant_id = $1) AS inbox,
         (SELECT count(*)::int FROM journal_transactions WHERE tenant_id = $1) AS journal,
         (SELECT count(*)::int FROM ledger_entries WHERE tenant_id = $1) AS entries,
         (SELECT count(*)::int FROM outbox WHERE tenant_id = $1) AS outbox,
         (SELECT coalesce(string_agg(account_id::text || ':' || amount::text, ',' ORDER BY account_id), '')
            FROM balances WHERE tenant_id = $1) AS balances,
         (SELECT count(*)::int FROM billing_webhook_events WHERE tenant_id = $1) AS webhooks`;

/**
 * Builds the payments services against the real Postgres as the runtime role. Wiring, repositories
 * and where the fault hook is called belong to the implementation; what the hook DOES, and the proof
 * that it sits after the write it claims to follow, belong to the test.
 */
export async function openHarness(opts: OpenOptions = {}): Promise<Harness> {
  process.env.DATABASE_URL ??=
    'postgresql://payments_app:payments-app-dev@localhost:54329/payments';
  const sql: string[] = [];
  const dataSource = await makeDataSource({
    poolMax: opts.poolMax,
    logger: opts.captureSql ? { logQuery: (q: string) => void sql.push(q) } : undefined,
  }).initialize();
  const secondary: DataSource[] = [];
  const admin = await connectAs('postgres');
  const cache = new FakeCache();
  const provider = new FakePaymentProvider({ webhookSecret: 'whsec_test_secret' });
  let armed: { point: FaultPoint; transient: boolean } | null = null;
  let fired = 0;

  const proveVisible = async (point: FaultPoint, manager: EntityManager | undefined) => {
    const misplaced = (why: string) =>
      new Error(
        `misplaced fault hook ${point}: ${why}; call it after that write, inside the transaction`,
      );
    if (point === 'reconciliation_scan') return;
    if (point === 'after_usage_report_sent') {
      if (provider.recordedUsage().length === 0) {
        throw misplaced('the provider has not recorded the usage report yet');
      }
      return;
    }
    if (!manager) throw misplaced('no transaction was passed');
    const t = (await manager.query(`SELECT current_setting('app.tenant_id', true) AS t`))[0]
      ?.t as string;
    if (!t) throw misplaced('the transaction carries no tenant');
    const inTx = ((await manager.query(SNAPSHOT_SQL, [t])) as Rows)[0]!;
    const committed = (await admin.query(SNAPSHOT_SQL, [t])).rows[0] as Record<string, unknown>;
    const grew = (k: string) => (inTx[k] as number) > (committed[k] as number);
    const visible: Record<string, boolean> = {
      after_inbox: grew('inbox'),
      after_journal: grew('journal') && grew('entries'),
      after_balance: inTx.balances !== committed.balances,
      after_outbox: grew('outbox'),
      webhook_apply: grew('webhooks'),
    };
    if (!visible[point])
      throw misplaced('the write it follows is not visible in the transaction yet');
  };

  // No tenancy module: the tenant comes from `runWithTenant` here, and from the service-kit auth
  // entry point in the app (the foundation `TenancyModule` is gone, D-4).
  const mod = await Test.createTestingModule({
    imports: [LedgerModule],
  })
    .overrideProvider(DATA_SOURCE)
    .useValue(dataSource)
    .overrideProvider(BALANCE_CACHE)
    .useValue(cache)
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(provider)
    .overrideProvider(LEDGER_FAULTS)
    .useValue({
      async hit(point: FaultPoint, manager?: EntityManager) {
        if (!armed || armed.point !== point) return;
        const { transient } = armed;
        armed = null;
        await proveVisible(point, manager);
        fired++;
        const err = new Error(`injected fault at ${point}`) as Error & { code?: string };
        if (transient) err.code = '40001';
        throw err;
      },
    })
    .compile();
  await mod.init();

  const inbox = mod.get(PaymentsInboxHandler);

  const consume: Harness['consume'] = async (event, o = {}) => {
    let ds = dataSource;
    if (o.instance === 2) {
      ds = await makeDataSource({}).initialize();
      secondary.push(ds);
    }
    const state = { acked: false, deadLettered: false, requeued: false };
    const settle = (requeue?: boolean) => {
      if (requeue) state.requeued = true;
      else state.deadLettered = true;
    };
    const channel = {
      ack: () => void (state.acked = true),
      reject: (_m: unknown, requeue?: boolean) => settle(requeue),
      nack: (_m: unknown, _all?: boolean, requeue?: boolean) => settle(requeue),
    } as unknown as Channel;
    const errors: unknown[] = [];
    const consumer = new InboxConsumer({
      dataSource: ds,
      channel,
      consumer: 'payments',
      handler: (manager, e) => inbox.handle(manager, e),
      onError: (err) => void errors.push(err),
    });
    const msg = {
      content: Buffer.from(JSON.stringify(event)),
      fields: {
        deliveryTag: 1,
        redelivered: false,
        exchange: 'mio.events',
        routingKey: event.type,
      },
      properties: { messageId: event.event_id },
    } as unknown as ConsumeMessage;
    const outcome = await consumer.onMessage(msg);
    return { outcome, ...state, errors };
  };

  const walletSql = (join: string, where: string) => `
    SELECT w.id AS wallet_id,
           coalesce(sum(b.amount) FILTER (WHERE a.kind = 'player_available'), 0)::int AS available,
           coalesce(sum(b.amount) FILTER (WHERE a.kind = 'player_held'), 0)::int AS held
      FROM wallets w ${join}
      JOIN accounts a ON a.tenant_id = w.tenant_id AND a.wallet_id = w.id
      JOIN balances b ON b.tenant_id = a.tenant_id AND b.account_id = a.id
     WHERE w.tenant_id = $1 AND ${where}
     GROUP BY w.id`;

  const dbWalletIn = async (
    tenantId: string,
    player: string,
    sandbox: boolean,
  ): Promise<DbWallet> => {
    const join = `JOIN wallet_owner_links l ON l.tenant_id = w.tenant_id AND l.wallet_id = w.id`;
    const { rows } = await admin.query(walletSql(join, `l.user_id = $2 AND w.sandbox = $3`), [
      tenantId,
      player,
      sandbox,
    ]);
    if (!rows[0]) throw new Error('dbWallet: no wallet for that player');
    return rows[0] as DbWallet;
  };

  return {
    ledger: mod.get(LedgerService),
    balances: mod.get(BalanceService),
    recon: mod.get(ReconciliationService),
    jobs: mod.get(LedgerJobsService),
    usage: mod.get(UsageService),
    billing: mod.get(BillingService),
    inbox,
    provider,
    cache,
    dataSource,
    admin,
    sql,
    poolMax: () =>
      (dataSource.driver as unknown as { master: { options: { max: number } } }).master.options.max,
    failAt: (point, o = {}) => {
      armed = point ? { point, transient: o.transient ?? false } : null;
    },
    faultsFired: () => fired,
    as: (tenantId, fn) => runWithTenant({ tenantId, principalId: 'engagement' }, fn),
    deliver: (tenantId, fn) =>
      runWithTenant({ tenantId, principalId: 'engagement' }, () =>
        withTenantTransaction(dataSource, fn),
      ),
    consume,
    fund: async (tenantId, player, amount) => {
      const spinId = uuidv7();
      const d = await consume(spinCompleted(tenantId, player, amount, { spinId }));
      if (d.outcome !== 'applied') throw new Error(`fund: expected applied, got ${d.outcome}`);
      return { spinId };
    },
    // X-2/D-13: a player has one wallet per environment (`wallets.sandbox`); `dbWallet` names the production one.
    dbWallet: (tenantId, player) => dbWalletIn(tenantId, player, false),
    dbWalletIn,
    dbWalletById: async (tenantId, walletId) => {
      const { rows } = await admin.query(walletSql('', `w.id = $2`), [tenantId, walletId]);
      if (!rows[0]) throw new Error('dbWalletById: no such wallet');
      return rows[0] as DbWallet;
    },
    sign: (raw) => provider.sign(raw),
    close: async () => {
      await admin.end();
      await mod.close();
      for (const ds of secondary) if (ds.isInitialized) await ds.destroy();
      if (dataSource.isInitialized) await dataSource.destroy();
    },
  };
}

/**
 * A `spin.completed` event as the engagement service writes it to its outbox (D-1). INV-ENV-INPUT:
 * the envelope's environment is always stated; `spinCompleted` is the PRODUCTION event and
 * `spinCompletedIn` takes the environment as a required first argument.
 */
export function spinCompleted(
  tenantId: string,
  player: string,
  reward: number,
  o: { spinId?: string; eventId?: string; at?: string; payload?: object } = {},
): EventEnvelope {
  return spinCompletedIn(false, tenantId, player, reward, o);
}

export function spinCompletedIn(
  sandbox: boolean,
  tenantId: string,
  player: string,
  reward: number,
  o: { spinId?: string; eventId?: string; at?: string; payload?: object } = {},
): EventEnvelope {
  const e = createEvent({
    type: 'engagement.spin.completed',
    tenantId,
    sandbox,
    payload: {
      spin_id: o.spinId ?? uuidv7(),
      player_id: player,
      reward_coins: reward,
      table_version: 1,
    },
  });
  return {
    ...e,
    event_id: o.eventId ?? e.event_id,
    occurred_at: o.at ?? e.occurred_at,
    payload: { ...(e.payload as object), ...(o.payload ?? {}) },
  } as EventEnvelope;
}

/** The body a provider webhook carries for one subscription at one provider version. */
export function snapshotBody(
  tenantId: string,
  subscriptionId: string,
  status: 'active' | 'past_due' | 'canceled',
  version: number,
  o: { eventId?: string; amountMinor?: number } = {},
): string {
  return JSON.stringify({
    eventId: o.eventId ?? `evt_${uuidv7()}`,
    tenantId,
    subscriptionId,
    status,
    version,
    amountMinor: o.amountMinor ?? 4900,
    currency: 'USD',
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
  });
}

/** Subscribe `tenantId` to a plan with the accepted test token and deliver the verified activation webhook. */
export async function activateSubscription(
  h: Harness,
  tenantId: string,
  planCode = 'pro',
): Promise<string> {
  const plan = (await h.billing.listPlans()).find((p) => p.code === planCode);
  if (!plan) throw new Error(`seed plan ${planCode} missing`);
  const sub = await h.as(tenantId, () =>
    h.billing.subscribe({ plan_id: plan.id, payment_method: 'tok_4242' }, key('sub')),
  );
  const subscriptionId = sub.body.provider_subscription_id;
  const raw = snapshotBody(tenantId, subscriptionId, 'active', 1, {
    amountMinor: plan.price_minor,
  });
  await h.billing.handleWebhook(raw, h.sign(raw));
  return subscriptionId;
}

export const newTenant = (): string => uuidv7();
export const newPlayer = (): string => uuidv7();
export const key = (prefix: string): string => `${prefix}-${uuidv7()}`;
