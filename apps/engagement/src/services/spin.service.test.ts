import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseEvent, type EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import {
  SEEDS,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
  type RewardTableVersion,
  type SpinCredit,
  type SpinRecord,
} from '../model/repositories';
import { SpinService } from './spin.service'; // RED: module missing
import { selectSegment } from './wheel'; // RED: module missing

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
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const A = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1'; // the player making the request
const B = '0190a1b2-c3d4-4e5f-8a6b-0000000000b2'; // another player of the same tenant
const WHEEL = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const credit = (n: number) => `0190a1b2-c3d4-4e5f-8a6b-00000000c${String(n).padStart(3, '0')}`;

const TABLE: RewardTableVersion = {
  wheelId: WHEEL,
  version: 6,
  segments: [
    { label: 'Win', weight: 1, reward: { type: 'coins', amount: 25 } },
    { label: 'Nothing', weight: 1, reward: { type: 'nothing' } },
  ],
};

describe('SpinService', () => {
  let service: SpinService;
  let credits: Map<string, SpinCredit>;
  let spins: Map<string, SpinRecord>;
  let published: Array<{ tx: unknown; event: EventEnvelope }>;
  let txs: unknown[];
  let consumeInputs: Array<{ userId: string; creditId?: string }>;
  let table: RewardTableVersion;

  beforeEach(async () => {
    credits = new Map();
    spins = new Map();
    published = [];
    txs = [];
    consumeInputs = [];
    table = TABLE;
    const creditsRepo = {
      // the atomic conditional update: first caller flips it, everyone else gets undefined
      async consume(_tx: unknown, input: { userId: string; creditId?: string }) {
        consumeInputs.push(input);
        const hit = [...credits.values()].find(
          (c) =>
            c.userId === input.userId &&
            c.status === 'available' &&
            (!input.creditId || c.id === input.creditId),
        );
        if (!hit) return undefined;
        hit.status = 'used';
        return { ...hit };
      },
      async findOwn(_tx: unknown, input: { userId: string; creditId: string }) {
        const c = credits.get(input.creditId);
        return c && c.userId === input.userId ? { ...c } : undefined;
      },
    };
    const spinsRepo = {
      async findByOperation(_tx: unknown, i: { userId: string; operationId: string }) {
        return spins.get(`${i.userId}|${i.operationId}`);
      },
      async insert(_tx: unknown, s: SpinRecord) {
        spins.set(`${s.userId}|${s.operationId}`, s);
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        SpinService,
        {
          provide: Db,
          useValue: {
            tenantTx: async (fn: (tx: unknown) => unknown) => {
              const tx = { n: txs.length + 1 };
              txs.push(tx);
              return fn(tx);
            },
            publish: async (tx: unknown, event: EventEnvelope) =>
              void published.push({ tx, event }),
          },
        },
        { provide: SpinCreditsRepository, useValue: creditsRepo },
        { provide: SpinsRepository, useValue: spinsRepo },
        { provide: WheelsRepository, useValue: { activeTable: async () => table } },
        { provide: SEEDS, useValue: { current: () => ({ version: 2, seed: 'seed-v2' }) } },
      ],
    }).compile();
    service = mod.get(SpinService);
  });

  const asPlayer = <R>(user: string, fn: () => Promise<R>) =>
    runWithTenant({ tenantId: T, principalId: user }, fn);
  const addCredit = (id: string, userId: string) =>
    credits.set(id, { id, userId, wheelId: WHEEL, status: 'available' });

  it('INV-SPIN-ONE-WINNER: 50 concurrent spins on one credit give exactly one result, 49 conflicts, one spin row', async () => {
    addCredit(credit(1), A);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        asPlayer(A, () => service.spin({ idempotencyKey: `k${i}` })),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(49);
    expect(failed.every((f) => f.reason instanceof ConflictException)).toBe(true);
    expect(spins.size).toBe(1);
    expect(published.filter((p) => p.event.type === 'engagement.spin.completed')).toHaveLength(1);
  });

  it('INV-SPIN-ONE-WINNER: a player with 3 credits and 50 concurrent requests gets exactly 3 spins', async () => {
    [1, 2, 3].forEach((n) => addCredit(credit(n), A));
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        asPlayer(A, () => service.spin({ idempotencyKey: `k${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(spins.size).toBe(3);
  });

  it("INV-SPIN-OWNERSHIP: another player's credit id is 404 and stays available; the user comes from the principal", async () => {
    addCredit(credit(9), B);
    await expect(
      asPlayer(A, () => service.spin({ idempotencyKey: 'k1', creditId: credit(9) })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(credits.get(credit(9))?.status).toBe('available');
    expect(spins.size).toBe(0);
    expect(consumeInputs.every((i) => i.userId === A)).toBe(true);
  });

  it('INV-SPIN-NO-CREDIT: no available credit is 409; an own but used credit is 409', async () => {
    await expect(asPlayer(A, () => service.spin({ idempotencyKey: 'k1' }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    credits.set(credit(2), { id: credit(2), userId: A, wheelId: WHEEL, status: 'used' });
    await expect(
      asPlayer(A, () => service.spin({ idempotencyKey: 'k2', creditId: credit(2) })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('INV-SPIN-SERVER-AUTHORITY: the stored outcome is the recomputable HMAC outcome of seed v2 and table v6', async () => {
    addCredit(credit(1), A);
    const res = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1' }));
    const row = [...spins.values()][0]!;
    expect(row.id).toBe(res.spin_id);
    expect(row).toMatchObject({ seedVersion: 2, tableVersion: 6, userId: A, creditId: credit(1) });
    const again = selectSegment({ seed: 'seed-v2', seedVersion: 2, spinId: row.id, table: TABLE });
    expect(row.segmentIndex).toBe(again.segmentIndex);
    expect(row.hmac).toBe(again.hmac);
    expect(res.segment_label).toBe(again.segment.label);
  });

  it('INV-SPIN-ATOMIC: spin row and spin.completed share one transaction', async () => {
    addCredit(credit(1), A);
    await asPlayer(A, () => service.spin({ idempotencyKey: 'k1' }));
    expect(txs).toHaveLength(1);
    expect(published.every((p) => p.tx === txs[0])).toBe(true);
  });

  it('INV-SPIN-EVENT: spin.completed carries spin_id, the player and the reward coins (payments keys on spin_id)', async () => {
    addCredit(credit(1), A);
    const res = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1' }));
    const ev = parseEvent(published[0]!.event);
    expect(ev.type).toBe('engagement.spin.completed');
    expect(ev.tenant_id).toBe(T);
    expect(ev.payload).toEqual({
      spin_id: res.spin_id,
      player_id: A,
      reward_coins: res.reward_coins,
    });
  });

  it('INV-SPIN-NOTHING: a `nothing` segment still completes the spin with 0 coins', async () => {
    table = { ...TABLE, segments: [{ label: 'Nothing', weight: 1, reward: { type: 'nothing' } }] };
    addCredit(credit(1), A);
    const res = await asPlayer(A, () => service.spin({ idempotencyKey: 'k1' }));
    expect(res.reward_coins).toBe(0);
    expect((published[0]!.event.payload as { reward_coins: number }).reward_coins).toBe(0);
  });

  it('INV-SPIN-REPLAY: the same Idempotency-Key returns the recorded spin and consumes no second credit', async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), A);
    const first = await asPlayer(A, () => service.spin({ idempotencyKey: 'same' }));
    const second = await asPlayer(A, () => service.spin({ idempotencyKey: 'same' }));
    expect(second).toEqual(first);
    expect([...credits.values()].filter((c) => c.status === 'available')).toHaveLength(1);
    expect(spins.size).toBe(1);
    expect(published).toHaveLength(1);
  });

  it("INV-SPIN-REPLAY-SCOPED: B's key is not A's: the same key by another player is a new operation", async () => {
    addCredit(credit(1), A);
    addCredit(credit(2), B);
    const a = await asPlayer(A, () => service.spin({ idempotencyKey: 'same' }));
    const b = await asPlayer(B, () => service.spin({ idempotencyKey: 'same' }));
    expect(b.spin_id).not.toBe(a.spin_id);
    expect(spins.size).toBe(2);
  });
});
