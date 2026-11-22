import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Db } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import {
  captureProductEvents,
  fakeTransaction,
  inFakeTransaction,
  type ProductEventCapture,
} from '@ex-mio/logger/testing';
import { createDefaultRegistry } from './integrations/registry';
import {
  ADAPTER_REGISTRY,
  CLOCK,
  InboundEventsRepository,
  PLAYER_DIRECTORY,
  TENANT_INTEGRATIONS,
  type TenantIntegration,
} from './integrations/ports';
import {
  SEEDS,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
} from './model/repositories';
import { World } from './redemptions/testing/world';
import type { SagaDeps, Scope } from './redemptions/ports';
import { IngestionService } from './services/ingestion.service';
import { RedemptionSagaService } from './services/redemption-saga.service';
import { SpinService } from './services/spin.service';

/*
 * Product analytics at the engagement choke points (D-19): IngestionService.ingest
 * (deposit_ingested), SpinService.spin (spin_completed), RedemptionSagaService.redeem / apply
 * (redemption_requested, redemption_resolved). Each test runs the REAL service method and asserts
 * exactly one line that conforms to the vendored Varta schema (the capture helper validates every
 * line with ajv and fails on a dropped event). The database transaction is driven like TypeORM
 * drives a real one, so a line written before the commit, or one that survives a rollback, shows.
 *
 * Mutations that must turn these red: emit before the commit (replace `emit*AfterCommit` by
 * `emitProductEventAs` in the services) -> the rollback tests; put the casino player id or an
 * email in props -> the no-leak assertions and the schema check.
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const PLAYER = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';
const RAW_CASINO_ID = 'casino-raw-player-77';

let cap: ProductEventCapture;
beforeEach(() => {
  cap = captureProductEvents();
});
afterEach(() => cap.stop());

const noLeak = (...secrets: string[]): void => {
  const text = JSON.stringify(cap.events());
  for (const s of secrets) expect(text).not.toContain(s);
};

// ---- deposit ------------------------------------------------------------------------------------

describe('engagement.deposit_ingested', () => {
  const NOW = new Date('2026-11-21T12:00:00.000Z');
  const signed = (secret: string) => {
    const ts = Math.floor(NOW.getTime() / 1000);
    const raw = JSON.stringify({
      eventId: 'evt-1',
      playerId: RAW_CASINO_ID,
      amount: { value: 5000, currency: 'EUR' },
      status: 'SUCCESS',
      ts,
    });
    return {
      raw,
      headers: {
        'x-a-timestamp': String(ts),
        'x-a-signature': createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex'),
      },
    };
  };

  async function build(opts: { environment?: string; failInsert?: boolean; duplicate?: boolean }) {
    const integration = {
      tenant_id: T,
      platform: 'casino-a',
      status: 'active',
      webhook_secrets: ['sec'],
      player_hash_key: 'hk',
      environment: opts.environment ?? 'production',
    } as unknown as TenantIntegration;
    const mod = await Test.createTestingModule({
      providers: [
        IngestionService,
        {
          provide: Db,
          useValue: {
            tenantTx: (fn: (tx: never) => Promise<unknown>) => inFakeTransaction(fn),
            publish: async () => undefined,
          },
        },
        {
          provide: InboundEventsRepository,
          useValue: {
            insertIfAbsent: async () => {
              if (opts.failInsert) throw new Error('db down');
              return { inserted: !opts.duplicate, id: '0190a1b2-c3d4-4e5f-8a6b-00000000000a' };
            },
          },
        },
        { provide: TENANT_INTEGRATIONS, useValue: { lookup: async () => integration } },
        { provide: ADAPTER_REGISTRY, useValue: createDefaultRegistry() },
        { provide: CLOCK, useValue: { now: () => NOW } },
        { provide: PLAYER_DIRECTORY, useValue: { resolveOrCreate: async () => PLAYER } },
      ],
    }).compile();
    return mod.get(IngestionService);
  }

  it('emits exactly one line after the commit, with the internal player and no casino player id', async () => {
    const service = await build({});
    const { raw, headers } = signed('sec');
    await service.ingest('acme', raw, headers);
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'engagement.deposit_ingested',
      tenant_id: T,
      actor_type: 'player',
      actor_id: PLAYER,
      props: { casino: 'casino-a', sandbox: false, amount_minor: 5000, currency: 'EUR' },
    });
    noLeak(RAW_CASINO_ID, 'sec');
  });

  it('carries the credential environment as sandbox', async () => {
    const service = await build({ environment: 'sandbox' });
    const { raw, headers } = signed('sec');
    await service.ingest('acme', raw, headers);
    expect(cap.events()[0]?.props).toMatchObject({ sandbox: true });
  });

  it('a rolled-back deposit, and a duplicate delivery, emit nothing', async () => {
    const failing = await build({ failInsert: true });
    const { raw, headers } = signed('sec');
    await expect(failing.ingest('acme', raw, headers)).rejects.toThrow('db down');
    expect(cap.events()).toEqual([]);

    const dup = await build({ duplicate: true });
    await dup.ingest('acme', raw, headers);
    expect(cap.events()).toEqual([]);
  });

  it('a refused webhook (bad signature) emits nothing', async () => {
    const service = await build({});
    const { raw, headers } = signed('wrong');
    await expect(service.ingest('acme', raw, headers)).rejects.toBeDefined();
    expect(cap.events()).toEqual([]);
  });
});

// ---- spin ---------------------------------------------------------------------------------------

describe('engagement.spin_completed', () => {
  async function build(opts: { failInsert?: boolean; existing?: boolean } = {}) {
    const mod = await Test.createTestingModule({
      providers: [
        SpinService,
        {
          provide: Db,
          useValue: {
            tenantTx: (fn: (tx: never) => Promise<unknown>) => inFakeTransaction(fn),
            publish: async () => undefined,
          },
        },
        {
          provide: SpinCreditsRepository,
          useValue: {
            consume: async () => ({ id: 'c1', userId: PLAYER, wheelId: 'w1', sandbox: false }),
          },
        },
        {
          provide: SpinsRepository,
          useValue: {
            findByOperation: async () =>
              opts.existing
                ? {
                    id: 's0',
                    userId: PLAYER,
                    creditId: 'c1',
                    segmentIndex: 0,
                    segmentLabel: 'Win',
                    rewardCoins: 25,
                  }
                : undefined,
            insert: async () => {
              if (opts.failInsert) throw new Error('db down');
            },
          },
        },
        {
          provide: WheelsRepository,
          useValue: {
            activeTable: async () => ({
              wheelId: 'w1',
              version: 1,
              segments: [{ label: 'Win', weight: 1, reward: { type: 'coins', amount: 25 } }],
            }),
          },
        },
        {
          provide: SEEDS,
          useValue: { current: () => ({ version: 1, seed: 'seed' }), seed: () => 'seed' },
        },
      ],
    }).compile();
    return mod.get(SpinService);
  }
  it('emits exactly one line after the commit: reward and environment, actor = the player', async () => {
    const service = await build();
    await runWithTenant({ tenantId: T, principalId: PLAYER }, () =>
      service.spin({ idempotencyKey: 'k1', sandbox: true }),
    );
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'engagement.spin_completed',
      tenant_id: T,
      actor_type: 'player',
      actor_id: PLAYER,
      props: { reward_coins: 25, sandbox: true },
    });
  });

  it('a rolled-back spin and a replay of the same key emit nothing', async () => {
    const failing = await build({ failInsert: true });
    await expect(
      runWithTenant({ tenantId: T, principalId: PLAYER }, () =>
        failing.spin({ idempotencyKey: 'k2', sandbox: false }),
      ),
    ).rejects.toThrow('db down');
    expect(cap.events()).toEqual([]);

    const replay = await build({ existing: true });
    await runWithTenant({ tenantId: T, principalId: PLAYER }, () =>
      replay.spin({ idempotencyKey: 'k2', sandbox: false }),
    );
    expect(cap.events()).toEqual([]);
  });

  it('is silent until the transaction commits', async () => {
    const t = fakeTransaction();
    const service = await build();
    // drive spinInTx through a Db whose commit we control
    const db = (service as unknown as { db: { tenantTx: unknown } }).db;
    const control = t;
    db.tenantTx = async (fn: (tx: never) => Promise<unknown>) => fn(control.tx as never);
    await runWithTenant({ tenantId: T, principalId: PLAYER }, () =>
      service.spin({ idempotencyKey: 'k3', sandbox: false }),
    );
    expect(cap.events()).toEqual([]);
    await control.commit();
    expect(cap.events()).toHaveLength(1);
  });
});

// ---- redemption ---------------------------------------------------------------------------------

describe('engagement.redemption_requested / redemption_resolved', () => {
  const P1 = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f0001';
  type W = World<RedemptionSagaService>;
  const scope = (w: W): Scope => ({ tenantId: w.tenant, playerId: P1, sandbox: false });

  function setup(coins = 100, wrap?: (deps: SagaDeps) => SagaDeps) {
    const w: W = new World((deps) => new RedemptionSagaService(wrap ? wrap(deps) : deps));
    w.payments.credit(P1, coins);
    const item = w.store.addItem({ price: 10, stock: 5, perPlayerLimit: null });
    return { w, item };
  }

  it('an order emits exactly one redemption_requested; the casino paying it emits one redemption_resolved status=completed', async () => {
    const { w, item } = setup();
    const { redemption } = await w.saga.redeem(scope(w), 'k1', item.id);
    expect(cap.events().map((e) => e.event)).toEqual(['engagement.redemption_requested']);
    expect(cap.events()[0]).toMatchObject({
      tenant_id: w.tenant,
      actor_type: 'player',
      actor_id: P1,
      props: { price_coins: 10, sandbox: false },
    });
    cap.clear();
    await w.settle();
    expect(w.store.redemptions.get(redemption.id)?.state).toBe('COMPLETED');
    const events = cap.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'engagement.redemption_resolved',
      actor_id: P1,
      props: { status: 'completed', price_coins: 10, sandbox: false },
    });
  });

  it('a refused order (insufficient funds) emits requested and resolved status=rejected_funds', async () => {
    const { w, item } = setup(0);
    await expect(w.saga.redeem(scope(w), 'k2', item.id)).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    expect(cap.events().map((e) => [e.event, e.props?.status])).toEqual([
      ['engagement.redemption_requested', undefined],
      ['engagement.redemption_resolved', 'rejected_funds'],
    ]);
  });

  it('a store write that fails, or loses its race, emits no resolved line', async () => {
    let mode: 'throw' | 'lose' = 'throw';
    const { w, item } = setup(100, (deps) => ({
      ...deps,
      store: Object.assign(Object.create(deps.store), {
        apply: async (tenantId: string, id: string, change: { to: string }) => {
          if (change.to !== 'COMPLETED') return deps.store.apply(tenantId, id, change as never);
          if (mode === 'throw') throw new Error('store down');
          const redemption = await deps.store.getForOperator(tenantId, id);
          return { applied: false, redemption: redemption! };
        },
      }),
    }));
    await w.saga.redeem(scope(w), 'k3', item.id);
    cap.clear();
    await w.settle(6).catch(() => undefined);
    expect(cap.events().filter((e) => e.event === 'engagement.redemption_resolved')).toEqual([]);
    mode = 'lose';
    await w.settle(6).catch(() => undefined);
    expect(cap.events().filter((e) => e.event === 'engagement.redemption_resolved')).toEqual([]);
  });

  it('an order the store rejects (unknown item) emits nothing', async () => {
    const { w } = setup();
    await expect(w.saga.redeem(scope(w), 'k4', 'no-such-item')).rejects.toBeDefined();
    expect(cap.events()).toEqual([]);
  });
});
