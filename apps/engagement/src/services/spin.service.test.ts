import 'reflect-metadata';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PublicWheel,
  SpinConflictBody,
  SpinResponse,
  parseEvent,
  type EventEnvelope,
} from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { currentTenant, runWithTenant } from '@ex-mio/tenancy';
import {
  SEEDS,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
  type RewardTableVersion,
  type SeedProvider,
  type SeedStore,
  type SpinCredit,
  type SpinRecord,
} from '../model/repositories';
import { createSeedProvider } from '../model/seeds';
import { SpinService } from './spin.service';
import { selectSegment } from './wheel';

// rc fix (INV-SPIN-ENV-NOAUTH): `availableSpins` fails closed without an auth context, as `spin` does in
// its controller. Over HTTP the service-kit interceptor sets the context; here a production player has it.
jest.mock('@ex-mio/service-kit', () => ({
  ...jest.requireActual('@ex-mio/service-kit'),
  currentAuth: () => ({ mode: 'user', principalId: 'p', roles: [] }),
}));

/** The versioned seed store the REAL provider reads (R2-3). A rotation is `add(tenant, v + 1, ...)`. */
class MemorySeedStore implements SeedStore {
  private readonly m = new Map<string, string>();
  add(tenantId: string, version: number, seed: string) {
    this.m.set(`${tenantId}|${version}`, seed);
  }
  drop(tenantId: string, version: number) {
    this.m.delete(`${tenantId}|${version}`);
  }
  versions(tenantId: string) {
    return [...this.m.keys()]
      .filter((k) => k.startsWith(`${tenantId}|`))
      .map((k) => Number(k.split('|')[1]));
  }
  get(tenantId: string, version: number) {
    return this.m.get(`${tenantId}|${version}`);
  }
}

/** The 409 code of a rejected spin (R2-5): the body of the ConflictException, parsed with the contract. */
const conflictCode = (reason: unknown) => {
  expect(reason).toBeInstanceOf(ConflictException);
  return SpinConflictBody.parse((reason as ConflictException).getResponse()).code;
};

/**
 * Server-authoritative spin (MIO-063, MIO-064). SpinService.spin({ idempotencyKey, creditId? }),
 * called inside runWithTenant({ tenantId, principalId }): the player is the PRINCIPAL, never input.
 *
 * Mutations:
 *  - take the user from the input / skip user_id in consume()            -> INV-SPIN-OWNERSHIP.
 *  - read-then-write instead of the single conditional consume()         -> INV-SPIN-ONE-WINNER
 *    (the real race is pinned by tests/compose/src/ingest.compose.test.ts).
 *  - choose the table / weights / segment from the request               -> INV-SPIN-SERVER-AUTHORITY.
 *  - insert the spin and publish in two transactions                     -> INV-SPIN-ATOMIC.
 *  - skip findByOperation (replay consumes a second credit)              -> INV-SPIN-REPLAY.
 *  - publish no event for a `nothing` segment                            -> INV-SPIN-EVENT (payments needs the spin).
 *  - call a payments HTTP credit endpoint from the spin path             -> INV-SPIN-NO-CREDIT-CALL (D-1:
 *    payments owns coins and consumes spin.completed; engagement only writes the outbox row).
 *  - consume the credit and insert the spin without the UNIQUE/idempotency serialisation
 *    -> INV-SPIN-REPLAY-PARALLEL (the mock Db rolls a failed transaction back, like Postgres).
 *  - same key with another credit_id returns the old spin instead of 422  -> INV-SPIN-REPLAY-BODY.
 *  - return the table as stored from SpinService.wheel                   -> INV-WHEEL-PUBLIC-NO-WEIGHTS (service).
 *  - recompute (or store) with the current seed instead of the seed of the stored version
 *                                                                        -> INV-SPIN-RECOMPUTE-AFTER-ROTATION.
 *    The seed provider here is the real `createSeedProvider` over a versioned store (R2-3); its own
 *    mutations are in model/seeds.test.ts.
 *  - omit `segment_index` from the spin result, or return a re-drawn one on replay -> INV-SPIN-SERVER-AUTHORITY.
 *  - count credits of every player (drop `user_id` from countAvailable), or take the user from input
 *                                                                        -> INV-ME-SPINS.
 *  - answer a same-key duplicate with `no_credit` (or any 409 without the contract `code`), or a
 *    player with nothing to spin with `in_progress`          -> INV-SPIN-REPLAY-PARALLEL,
 *                                                               INV-SPIN-NO-CREDIT, INV-SPIN-ONE-WINNER (R2-5).
 *
 * The in-memory consume() is atomic by construction (no await between find and set), so this file
 * cannot see a read-then-write race; that race, the one-row limit and ownership with a dropped
 * `user_id` are pinned in SQL by tests/compose/src/ingest.compose.test.ts.
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const A = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1'; // the player making the request
const B = '0190a1b2-c3d4-4e5f-8a6b-0000000000b2'; // another player of the same tenant
const WHEEL = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
/**
 * The stored operation id of player A's production request with this Idempotency-Key (D-26), written
 * out LITERALLY as `spin:<tenant>:prd:<user>:<key>` (the keys used here need no escaping). Never
 * derived from `scopedKey`, the code under test (final review F2).
 */
const op = (key: string): string => `spin:${T}:prd:${A}:${key}`;
const credit = (n: number) => `0190a1b2-c3d4-4e5f-8a6b-00000000c${String(n).padStart(3, '0')}`;

const TABLE: RewardTableVersion = {
  wheelId: WHEEL,
  version: 6,
  segments: [
    { label: 'Win', weight: 1, reward: { type: 'coins', amount: 25 } },
    { label: 'Nothing', weight: 1, reward: { type: 'nothing' } },
  ],
};

/** The mock transaction handle: a number and an undo log applied when the transaction throws. */
interface Tx {
  n: number;
  undo: Array<() => void>;
}

describe('SpinService', () => {
  let service: SpinService;
  let credits: Map<string, SpinCredit>;
  let spins: Map<string, SpinRecord>;
  let published: Array<{ tx: unknown; event: EventEnvelope }>;
  let txs: unknown[];
  let consumeInputs: Array<{ userId: string; creditId?: string }>;
  let countInputs: Array<{ userId: string }>;
  let table: RewardTableVersion;
  let seedStore: MemorySeedStore;
  let seedsPort: SeedProvider;
  const SEED_BY_VERSION: Record<number, string> = { 1: 'seed-v1', 2: 'seed-v2' };

  beforeEach(async () => {
    credits = new Map();
    spins = new Map();
    published = [];
    txs = [];
    consumeInputs = [];
    countInputs = [];
    table = TABLE;
    seedStore = new MemorySeedStore(); // R2-3: the REAL provider reads this versioned store
    seedStore.add(T, 1, SEED_BY_VERSION[1]!);
    seedStore.add(T, 2, SEED_BY_VERSION[2]!); // current = 2 unless a test starts from v1
    const creditsRepo = {
      // the atomic conditional update: first caller flips it, everyone else gets undefined
      async consume(tx: unknown, input: { userId: string; creditId?: string }) {
        consumeInputs.push(input);
        const hit = [...credits.values()].find(
          (c) =>
            c.userId === input.userId &&
            c.status === 'available' &&
            (!input.creditId || c.id === input.creditId),
        );
        if (!hit) return undefined;
        hit.status = 'used';
        (tx as Tx).undo.push(() => void (hit.status = 'available'));
        return { ...hit };
      },
      async countAvailable(_tx: unknown, input: { userId: string }) {
        countInputs.push(input);
        return [...credits.values()].filter(
          (c) => c.userId === input.userId && c.status === 'available',
        ).length;
      },
      async findOwn(_tx: unknown, input: { userId: string; creditId: string }) {
        const c = credits.get(input.creditId);
        return c && c.userId === input.userId ? { ...c } : undefined;
      },
    };
    const spinsRepo = {
      // operation_id is a plain, NON-unique index since EnvScopedKeys: a lookup, first match wins
      async findByOperation(_tx: unknown, i: { userId: string; operationId: string }) {
        return [...spins.values()].find(
          (s) => s.userId === i.userId && s.operationId === i.operationId,
        );
      },
      async insert(tx: unknown, s: SpinRecord) {
        // models the ONLY unique key spins has now, PRIMARY KEY (tenant_id, id); the spin id is
        // derived from the environment-scoped key, so a same-key duplicate collides here
        const pk = `${currentTenant().tenantId}|${s.id}`;
        if (spins.has(pk))
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          });
        spins.set(pk, s);
        (tx as Tx).undo.push(() => void spins.delete(pk));
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        SpinService,
        {
          provide: Db,
          useValue: {
            // a transaction that throws is rolled back: its own credit updates, spin rows and
            // outbox rows revert (an undo log per transaction; other transactions are untouched)
            tenantTx: async (fn: (tx: unknown) => unknown) => {
              const tx: Tx = { n: txs.length + 1, undo: [] };
              txs.push(tx);
              try {
                return await fn(tx);
              } catch (e) {
                tx.undo.reverse().forEach((u) => u());
                for (let i = published.length - 1; i >= 0; i--)
                  if (published[i]!.tx === tx) published.splice(i, 1);
                throw e;
              }
            },
            publish: async (tx: unknown, event: EventEnvelope) =>
              void published.push({ tx, event }),
          },
        },
        { provide: SpinCreditsRepository, useValue: creditsRepo },
        { provide: SpinsRepository, useValue: spinsRepo },
        { provide: WheelsRepository, useValue: { activeTable: async () => table } },
        { provide: SEEDS, useValue: createSeedProvider(seedStore) },
      ],
    }).compile();
    service = mod.get(SpinService);
    seedsPort = mod.get<SeedProvider>(SEEDS);
  });

  const asPlayer = <R>(user: string, fn: () => Promise<R>) =>
    runWithTenant({ tenantId: T, principalId: user }, fn);
  /** Player A's stored production spin for this Idempotency-Key, found by its literal operation id. */
  const byOp = (key: string): SpinRecord | undefined =>
    [...spins.values()].find((s) => s.userId === A && s.operationId === op(key));
  const addCredit = (id: string, userId: string) =>
    credits.set(id, { id, userId, wheelId: WHEEL, status: 'available', sandbox: false });

  it('INV-SPIN-ONE-WINNER: 50 concurrent spins on one credit give exactly one result, 49 conflicts, one spin row', async () => {
    addCredit(credit(1), A);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        asPlayer(A, () => service.spin({ idempotencyKey: `k${i}`, sandbox: false })),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(49);
    // different keys: the losers have nothing left to spin, `no_credit` (the client stops, R2-5)
    expect(failed.map((f) => conflictCode(f.reason))).toEqual(Array(49).fill('no_credit'));
    expect(spins.size).toBe(1);
    expect(published.filter((p) => p.event.type === 'engagement.spin.completed')).toHaveLength(1);
  });

  it('INV-SPIN-ONE-WINNER: a player with 3 credits and 50 concurrent requests gets exactly 3 spins', async () => {
    [1, 2, 3].forEach((n) => addCredit(credit(n), A));
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        asPlayer(A, () => service.spin({ idempotencyKey: `k${i}`, sandbox: false })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed.map((f) => conflictCode(f.reason))).toEqual(Array(47).fill('no_credit'));
    expect(spins.size).toBe(3);
  });

  it("INV-SPIN-OWNERSHIP: another player's credit id is 404 and stays available; the user comes from the principal", async () => {
    addCredit(credit(9), B);
    await expect(
      asPlayer(A, () =>
        service.spin({ idempotencyKey: 'k1', creditId: credit(9), sandbox: false }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(credits.get(credit(9))?.status).toBe('available');
    expect(spins.size).toBe(0);
    expect(consumeInputs.length).toBeGreaterThan(0); // `every` over an empty list is vacuously true
    expect(consumeInputs.every((i) => i.userId === A)).toBe(true);
  });

  it("INV-SPIN-OWNERSHIP: without a credit id the player consumes only their own credit, never another player's", async () => {
    addCredit(credit(9), B);
    const err = await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'k1', sandbox: false }),
    ).catch((e) => e);
    expect(conflictCode(err)).toBe('no_credit');
    expect(credits.get(credit(9))?.status).toBe('available');
    expect(consumeInputs.length).toBeGreaterThan(0);
    expect(consumeInputs.every((i) => i.userId === A)).toBe(true);
  });

  it('INV-SPIN-NO-CREDIT: no available credit is 409 `no_credit`; an own but used credit is 409 `no_credit`', async () => {
    const first = await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'k1', sandbox: false }),
    ).catch((e) => e);
    expect(conflictCode(first)).toBe('no_credit');
    credits.set(credit(2), { id: credit(2), userId: A, wheelId: WHEEL, status: 'used' });
    const used = await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'k2', creditId: credit(2), sandbox: false }),
    ).catch((e) => e);
    expect(conflictCode(used)).toBe('no_credit');
  });

  it('INV-SPIN-SERVER-AUTHORITY: the stored outcome is the recomputable HMAC outcome of seed v2 and table v6', async () => {
    addCredit(credit(1), A);
    const res = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
    const row = [...spins.values()][0]!;
    expect(row.id).toBe(res.spin_id);
    expect(row).toMatchObject({ seedVersion: 2, tableVersion: 6, userId: A, creditId: credit(1) });
    const again = selectSegment({ seed: 'seed-v2', seedVersion: 2, spinId: row.id, table: TABLE });
    expect(row.segmentIndex).toBe(again.segmentIndex);
    expect(row.hmac).toBe(again.hmac);
    expect(res.segment_label).toBe(again.segment.label);
    // the web wheel animates to the server's result: the response carries the stored index (coordinator)
    expect(res.segment_index).toBe(row.segmentIndex);
    expect(SpinResponse.safeParse(res).success).toBe(true);
    // a replay returns the same index
    const replay = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
    expect(replay.segment_index).toBe(row.segmentIndex);
  });

  it("INV-ME-SPINS: availableSpins() is the player's own count of available credits: used, other players' and nothing-yet do not count; the user is the principal", async () => {
    expect(await asPlayer(A, () => service.availableSpins())).toEqual({ available: 0 });
    [1, 2, 3].forEach((n) => addCredit(credit(n), A));
    addCredit(credit(8), B);
    credits.set(credit(9), { id: credit(9), userId: A, wheelId: WHEEL, status: 'used' });
    expect(await asPlayer(A, () => service.availableSpins())).toEqual({ available: 3 });
    expect(await asPlayer(B, () => service.availableSpins())).toEqual({ available: 1 });
    await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
    expect(await asPlayer(A, () => service.availableSpins())).toEqual({ available: 2 });
    expect(countInputs).toHaveLength(4);
    expect(countInputs.map((c) => c.userId)).toEqual([A, A, B, A]);
  });

  it('INV-SPIN-ATOMIC: spin row and spin.completed share one transaction', async () => {
    addCredit(credit(1), A);
    await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
    expect(txs).toHaveLength(1);
    expect(published.every((p) => p.tx === txs[0])).toBe(true);
  });

  it('INV-SPIN-EVENT: spin.completed carries spin_id, the player, the reward coins and the table version (payments keys on spin_id)', async () => {
    addCredit(credit(1), A);
    const res = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
    const ev = parseEvent(published[0]!.event);
    expect(ev.type).toBe('engagement.spin.completed');
    expect(ev.tenant_id).toBe(T);
    expect(ev.payload).toEqual({
      spin_id: res.spin_id,
      player_id: A,
      reward_coins: res.reward_coins,
      table_version: 6,
    });
    expect(published[0]!.event.sandbox).toBe(false); // production: stated on the envelope, never absent
  });

  // X-3/D-13, the producer side. The spin is the producer of spin.completed: a spin that runs for a
  // sandbox token (the controller passes `sandbox: true` from the `sbx` claim) writes the event with
  // envelope.sandbox = true, so payments credits the sandbox wallet and meters nothing (X-2).
  // Mutation: drop `sandbox` when building the envelope, or write it for a production spin.
  it('INV-SPIN-SANDBOX: a sandbox spin publishes spin.completed with envelope.sandbox = true; the payload has no sandbox field', async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), A);
    await asPlayer(A, () => service.spin({ idempotencyKey: 'k-sbx', sandbox: true }));
    await asPlayer(A, () => service.spin({ idempotencyKey: 'k-prod', sandbox: false }));
    const [sbx, prod] = published.map((p) => parseEvent(p.event));
    expect(sbx!.sandbox).toBe(true);
    expect('sandbox' in (sbx!.payload as object)).toBe(false);
    expect(prod!.sandbox).toBe(false);
  });

  it('INV-SPIN-SANDBOX: spin.completed is a sandbox event exactly when the credit came from a sandbox credential (F3, D-13)', async () => {
    const sandboxOf = (e: EventEnvelope) => (e as { sandbox?: boolean }).sandbox;
    addCredit(credit(1), A);
    addCredit(credit(2), A);
    (credits.get(credit(1)) as { sandbox?: boolean }).sandbox = true;
    (credits.get(credit(2)) as { sandbox?: boolean }).sandbox = false;
    await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'k1', creditId: credit(1), sandbox: false }),
    );
    await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'k2', creditId: credit(2), sandbox: false }),
    );
    expect(published).toHaveLength(2);
    expect(sandboxOf(published[0]!.event)).toBe(true);
    expect(sandboxOf(published[1]!.event)).not.toBe(true);
  });

  it('INV-SPIN-NO-CREDIT-CALL: the spin path makes no HTTP call; coins come from payments consuming spin.completed (D-1)', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('the spin path must not call payments over HTTP');
    });
    try {
      addCredit(credit(1), A);
      await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(published.map((p) => p.event.type)).toEqual(['engagement.spin.completed']);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('INV-SPIN-NOTHING: a `nothing` segment still completes the spin with 0 coins', async () => {
    table = { ...TABLE, segments: [{ label: 'Nothing', weight: 1, reward: { type: 'nothing' } }] };
    addCredit(credit(1), A);
    const res = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1', sandbox: false }));
    expect(res.reward_coins).toBe(0);
    expect((published[0]!.event.payload as { reward_coins: number }).reward_coins).toBe(0);
  });

  it('INV-SPIN-REPLAY: the same Idempotency-Key returns the recorded spin and consumes no second credit', async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), A);
    const first = await asPlayer(A, () => service.spin({ idempotencyKey: 'same', sandbox: false }));
    const second = await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'same', sandbox: false }),
    );
    expect(second).toEqual(first);
    expect([...credits.values()].filter((c) => c.status === 'available')).toHaveLength(1);
    expect(spins.size).toBe(1);
    expect(published).toHaveLength(1);
  });

  it("INV-SPIN-REPLAY-SCOPED: B's key is not A's: the same key by another player is a new operation", async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), B);
    const a = await asPlayer(A, () => service.spin({ idempotencyKey: 'same', sandbox: false }));
    const b = await asPlayer(B, () => service.spin({ idempotencyKey: 'same', sandbox: false }));
    expect(b.spin_id).not.toBe(a.spin_id);
    expect(spins.size).toBe(2);
  });

  it('INV-SPIN-REPLAY-PARALLEL: 20 parallel requests with one key and two credits give one spin and one used credit; the others replay it or get 409', async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), A);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        asPlayer(A, () => service.spin({ idempotencyKey: 'same', sandbox: false })),
      ),
    );
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<SpinService['spin']>>> =>
        r.status === 'fulfilled',
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((r) => r.value.spin_id)).size).toBe(1);
    // R2-5: a same-key duplicate is `in_progress` (retry with the key), NOT `no_credit`: a credit
    // is still available (two were seeded), so "no spins left" would be a lie to the client.
    expect(failed.map((f) => conflictCode(f.reason))).toEqual(
      Array(failed.length).fill('in_progress'),
    );
    expect(spins.size).toBe(1);
    expect([...credits.values()].filter((c) => c.status === 'used')).toHaveLength(1);
    expect(published.filter((p) => p.event.type === 'engagement.spin.completed')).toHaveLength(1);
    // a later replay returns the stored result
    const later = await asPlayer(A, () => service.spin({ idempotencyKey: 'same', sandbox: false }));
    expect(later.spin_id).toBe(ok[0]!.value.spin_id);
    expect(spins.size).toBe(1);
  });

  it('INV-SPIN-REPLAY-BODY: the same key with a different credit_id is 422 and changes nothing', async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), A);
    const first = await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'same', creditId: credit(1), sandbox: false }),
    );
    await expect(
      asPlayer(A, () =>
        service.spin({ idempotencyKey: 'same', creditId: credit(2), sandbox: false }),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(credits.get(credit(2))?.status).toBe('available');
    expect(spins.size).toBe(1);
    const again = await asPlayer(A, () =>
      service.spin({ idempotencyKey: 'same', creditId: credit(1), sandbox: false }),
    );
    expect(again).toEqual(first);
  });

  it('INV-WHEEL-PUBLIC-NO-WEIGHTS (service): SpinService.wheel returns labels only, built from the stored table, and 404 for an unknown wheel', async () => {
    const view = await asPlayer(A, () => service.wheel(WHEEL));
    expect(PublicWheel.safeParse(view).success).toBe(true);
    expect(view.wheel_id).toBe(WHEEL);
    expect(view.segments.map((s) => s.label)).toEqual(['Win', 'Nothing']);
    expect(JSON.stringify(view)).not.toMatch(/weight|seed|version|reward|amount/i);
    table = undefined as unknown as RewardTableVersion;
    await expect(asPlayer(A, () => service.wheel(WHEEL))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('INV-SPIN-RECOMPUTE-AFTER-ROTATION: a spin stored under seed v1 is recomputed from seed v1 after the current seed moved to v2', async () => {
    seedStore.drop(T, 2); // the store holds v1 only: current = 1
    addCredit(credit(1), A);
    const old = await asPlayer(A, () => service.spin({ idempotencyKey: 'old', sandbox: false }));
    const stored = byOp('old')!;
    expect(stored.seedVersion).toBe(1);
    seedStore.add(T, 2, SEED_BY_VERSION[2]!); // rotation: a new version in the store
    addCredit(credit(2), A);
    const fresh = await asPlayer(A, () => service.spin({ idempotencyKey: 'new', sandbox: false }));
    expect(byOp('new')!.seedVersion).toBe(2);
    expect(byOp('old')).toEqual(stored); // the old record is untouched by the rotation

    // R2-3: `seeds` is the REAL provider (model/seeds.ts) over the versioned store, not test-owned
    // arithmetic. A provider whose seed(tenant, v) returns the current seed fails the next line.
    const seeds = seedsPort;
    expect(seeds.seed(T, 1)).toBe(SEED_BY_VERSION[1]);
    const byVersion = selectSegment({
      seed: seeds.seed(T, stored.seedVersion), // by the STORED version, not current()
      seedVersion: stored.seedVersion,
      spinId: old.spin_id,
      table: TABLE,
    });
    expect(byVersion.hmac).toBe(stored.hmac);
    expect(byVersion.segmentIndex).toBe(stored.segmentIndex);
    const withCurrent = selectSegment({
      seed: seeds.current(T).seed,
      seedVersion: 2,
      spinId: old.spin_id,
      table: TABLE,
    });
    expect(withCurrent.hmac).not.toBe(stored.hmac); // the current seed would NOT reproduce it
    expect(byOp('new')!.hmac).toBe(
      selectSegment({
        seed: SEED_BY_VERSION[2]!,
        seedVersion: 2,
        spinId: fresh.spin_id,
        table: TABLE,
      }).hmac,
    );
  });
});
