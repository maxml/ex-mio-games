import 'reflect-metadata';
import { ConflictException, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { EventEnvelope } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import {
  SEEDS,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
  type RewardTableVersion,
  type SeedStore,
  type SpinCredit,
  type SpinRecord,
} from '../model/repositories';
import { createSeedProvider } from '../model/seeds';
import { SpinService } from './spin.service';

/*
 * Final review (D-26, question 1): the spins UNIQUE (tenant_id, user_id, operation_id) was dropped
 * in 1732800000000-EnvScopedKeys. What dedupes a spin now is the primary key (tenant_id, id) plus
 * an id DERIVED from the environment-scoped key. These fakes model the schema as it is NOW: the
 * only uniqueness is (tenant_id, id); `operation_id` is a plain, non-unique index. The frozen
 * spin.service.test.ts still models the OLD unique key, so it cannot see the new choke point
 * (an id minted with uuidv7() stays green there: measured in the review).
 *
 * Mutations, each re-applied in the review:
 *  - spin.service.ts `const spinId = uuidv7()` instead of `uuidFromKey(operationId)`
 *                                                       -> SPIN-DEDUPE-3 red (two spins, two credits)
 *  - the `spin` operation key built with `sandbox: false` -> SPIN-DEDUPE-1 red (the sandbox
 *    request replays the production spin)
 *  - (SPIN-KEY-BOUND is RED at a4d97bb: scopedKey throws a plain Error for a key the controller
 *    accepted, which is a 500.)
 */

const T = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const A = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';
const WHEEL = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const credit = (n: number) => `0190a1b2-c3d4-4e5f-8a6b-00000000c${String(n).padStart(3, '0')}`;

const TABLE: RewardTableVersion = {
  wheelId: WHEEL,
  version: 1,
  segments: [
    { label: 'Win', weight: 1, reward: { type: 'coins', amount: 25 } },
    { label: 'Nothing', weight: 1, reward: { type: 'nothing' } },
  ],
};

class Seeds implements SeedStore {
  versions() {
    return [1];
  }
  get() {
    return 'seed-v1';
  }
}

interface Tx {
  undo: Array<() => void>;
}

/** One database shared by every SpinService instance ("process") built over it. */
class World {
  readonly credits = new Map<string, SpinCredit & { sandbox?: boolean }>();
  /** Keyed by the PRIMARY KEY (tenant_id, id): the only unique key spins has now. */
  readonly spins = new Map<string, SpinRecord & { tenantId: string }>();
  readonly published: Array<{ tx: Tx; event: EventEnvelope }> = [];
  /** When set, the first `n` findByOperation calls wait until all `n` have arrived. */
  race: { n: number; arrived: number; release: () => void; gate: Promise<void> } | null = null;

  raceFinds(n: number): void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.race = { n, arrived: 0, release, gate };
  }

  addCredit(id: string, sandbox = false): void {
    this.credits.set(id, { id, userId: A, wheelId: WHEEL, status: 'available', sandbox });
  }

  used(): number {
    return [...this.credits.values()].filter((c) => c.status === 'used').length;
  }

  service(): Promise<SpinService> {
    return buildService(this);
  }
}

/** One SpinService instance (one "process") over the shared world. */
async function buildService(w: World): Promise<SpinService> {
  {
    const mod = await Test.createTestingModule({
      providers: [
        SpinService,
        {
          provide: Db,
          useValue: {
            tenantTx: async (fn: (tx: Tx) => unknown) => {
              const tx: Tx = { undo: [] };
              try {
                return await fn(tx);
              } catch (e) {
                tx.undo.reverse().forEach((u) => u());
                for (let i = w.published.length - 1; i >= 0; i--)
                  if (w.published[i]!.tx === tx) w.published.splice(i, 1);
                throw e;
              }
            },
            publish: async (tx: Tx, event: EventEnvelope) => void w.published.push({ tx, event }),
          },
        },
        {
          provide: SpinCreditsRepository,
          useValue: {
            async consume(tx: Tx, i: { userId: string; sandbox: boolean; creditId?: string }) {
              const hit = [...w.credits.values()].find(
                (c) =>
                  c.userId === i.userId &&
                  c.status === 'available' &&
                  (c.sandbox === true) === i.sandbox &&
                  (!i.creditId || c.id === i.creditId),
              );
              if (!hit) return undefined;
              hit.status = 'used';
              tx.undo.push(() => void (hit.status = 'available'));
              return { ...hit };
            },
            async countAvailable() {
              return 0;
            },
            async findOwn() {
              return undefined;
            },
          },
        },
        {
          provide: SpinsRepository,
          useValue: {
            // operation_id is NOT unique any more: a plain lookup, first match wins.
            async findByOperation(_tx: Tx, i: { userId: string; operationId: string }) {
              const race = w.race;
              if (race && race.arrived < race.n) {
                race.arrived += 1;
                if (race.arrived === race.n) race.release();
                await race.gate;
              }
              return [...w.spins.values()].find(
                (s) => s.userId === i.userId && s.operationId === i.operationId,
              );
            },
            async insert(tx: Tx, s: SpinRecord) {
              const pk = `${T}|${s.id}`;
              if (w.spins.has(pk))
                throw Object.assign(new Error('duplicate key value violates "spins_pkey"'), {
                  code: '23505',
                });
              w.spins.set(pk, { ...s, tenantId: T });
              tx.undo.push(() => void w.spins.delete(pk));
            },
          },
        },
        { provide: WheelsRepository, useValue: { activeTable: async () => TABLE } },
        { provide: SEEDS, useValue: createSeedProvider(new Seeds()) },
      ],
    }).compile();
    return mod.get(SpinService);
  }
}

const asA = <R>(fn: () => Promise<R>) => runWithTenant({ tenantId: T, principalId: A }, fn);
const completed = (w: World) =>
  w.published.filter((p) => p.event.type === 'engagement.spin.completed');

describe('final review: spin dedupe after the spins UNIQUE was dropped (D-26 question 1)', () => {
  it('SPIN-DEDUPE-1 the same Idempotency-Key in production and in sandbox is two spins, and each environment replays its own', async () => {
    const w = new World();
    w.addCredit(credit(1), false);
    w.addCredit(credit(2), true);
    const svc = await w.service();

    const prd = await asA(() => svc.spin({ idempotencyKey: 'k1', sandbox: false }));
    const sbx = await asA(() => svc.spin({ idempotencyKey: 'k1', sandbox: true }));
    expect(sbx.spin_id).not.toBe(prd.spin_id);
    expect(w.spins.size).toBe(2);
    expect(w.used()).toBe(2);

    // replays: each environment gets its own stored result and spends nothing
    expect((await asA(() => svc.spin({ idempotencyKey: 'k1', sandbox: false }))).spin_id).toBe(
      prd.spin_id,
    );
    expect((await asA(() => svc.spin({ idempotencyKey: 'k1', sandbox: true }))).spin_id).toBe(
      sbx.spin_id,
    );
    expect(w.spins.size).toBe(2);
    const events = completed(w);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event.sandbox === true)).toEqual([false, true]);
  });

  it('SPIN-DEDUPE-2 a replay after a restart (a new process, empty in-flight set) returns the stored spin and spends no credit', async () => {
    const w = new World();
    w.addCredit(credit(1));
    w.addCredit(credit(2));
    const first = await asA(async () =>
      (await w.service()).spin({ idempotencyKey: 'k1', sandbox: false }),
    );
    const restarted = await w.service();
    const again = await asA(() => restarted.spin({ idempotencyKey: 'k1', sandbox: false }));
    expect(again.spin_id).toBe(first.spin_id);
    expect(again.segment_index).toBe(first.segment_index);
    expect(w.spins.size).toBe(1);
    expect(w.used()).toBe(1);
    expect(completed(w)).toHaveLength(1);
  });

  it('SPIN-DEDUPE-3 concurrent duplicates in two processes: one spin, one credit, one spin.completed; the loser is 409 in_progress or the same spin', async () => {
    const w = new World();
    w.addCredit(credit(1));
    w.addCredit(credit(2));
    const p1 = await w.service();
    const p2 = await w.service(); // separate in-flight sets: only the database can serialise them
    w.raceFinds(2); // both see "no spin yet" before either inserts
    const results = await Promise.allSettled([
      asA(() => p1.spin({ idempotencyKey: 'k1', sandbox: false })),
      asA(() => p2.spin({ idempotencyKey: 'k1', sandbox: false })),
    ]);
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<SpinService['spin']>>> =>
        r.status === 'fulfilled',
    );
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.spin_id)).size).toBe(1);
    expect(w.spins.size).toBe(1);
    expect(w.used()).toBe(1);
    expect(completed(w)).toHaveLength(1);
  });

  it('SPIN-KEY-BOUND every Idempotency-Key the spin controller accepts (1..200 chars, any character) spins or gets a 4xx, never a 500', async () => {
    // spin.controller.ts: IdempotencyKey = z.string().min(1).max(200). scopedKey escapes `:`, `|`
    // and `%` to three characters each and refuses keys over 512, with a plain Error (a 500).
    for (const key of [':'.repeat(200), '|'.repeat(200), '%'.repeat(200), 'k'.repeat(200)]) {
      const w = new World();
      w.addCredit(credit(1));
      const svc = await w.service();
      const outcome = await asA(() => svc.spin({ idempotencyKey: key, sandbox: false })).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      if (!outcome.ok) {
        expect(outcome.e).toBeInstanceOf(HttpException);
        expect((outcome.e as HttpException).getStatus()).toBeLessThan(500);
      }
    }
  });
});
