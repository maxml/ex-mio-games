import { createHmac, randomUUID } from 'node:crypto';
import { PublicWheel, type RewardSegment } from '@ex-mio/contracts';
import type { RewardTableVersion } from '../model/repositories';
import { probabilities, selectSegment, toPublicWheel } from './wheel'; // RED: module missing

/**
 * Wheel (MIO-062, MIO-063, MIO-069). Pure functions, docs/specs section 8:
 *   selectSegment({ seed, seedVersion, spinId, table }) -> { segmentIndex, segment, hmac, seedVersion, tableVersion }
 *   probabilities(table) -> number[]          (segment weight / total weight)
 *   toPublicWheel(table)  -> PublicWheel      (labels only)
 *
 * Pinned algorithm (the oracle below re-implements it independently):
 *   hmac  = HMAC-SHA256(key = seed, message = spinId) as lower-case hex
 *   roll  = integer of the first 6 bytes (12 hex chars) of hmac, 0 .. 2^48-1
 *   pick  = floor(roll * totalWeight / 2^48)                      (BigInt, no modulo bias beyond 2^-48)
 *   segment = first segment whose cumulative weight > pick
 *
 * Mutations:
 *  - `roll % total` instead of the scaled pick, or Math.random()        -> INV-WHEEL-DETERMINISTIC.
 *  - HMAC key/message swapped, or seed version ignored                  -> INV-WHEEL-DETERMINISTIC.
 *  - off-by-one in the cumulative comparison (>= for >)                 -> INV-WHEEL-DISTRIBUTION.
 *  - drop the table validation in selectSegment                         -> INV-WHEEL-REJECTS-BAD-TABLE.
 *  - toPublicWheel returns the segments as stored                       -> INV-WHEEL-PUBLIC-NO-WEIGHTS.
 *  - recompute with another seed than the stored version's              -> INV-SPIN-RECOMPUTE-AFTER-ROTATION
 *    (the service-level twin, with the SEEDS.seed(tenant, version) port, is in spin.service.test.ts).
 *
 * `WHEEL_DIST_N` sets the sample of the distribution test: default 1,000,000 (MIO-063); a loaded
 * machine may use 200,000 (binomial sd <= 0.11 pp against the 0.5 pp bound). The oracle test, not
 * this one, is what catches `% total`: the distribution test catches only gross bias.
 */

const W = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const seg = (label: string, weight: number, coins: number): RewardSegment => ({
  label,
  weight,
  reward: coins > 0 ? { type: 'coins', amount: coins } : { type: 'nothing' },
});
const table = (segments: RewardSegment[], version = 3): RewardTableVersion => ({
  wheelId: W,
  version,
  segments,
});

function oracle(seed: string, spinId: string, weights: number[]): { hmac: string; index: number } {
  const hmac = createHmac('sha256', seed).update(spinId).digest('hex');
  const roll = BigInt('0x' + hmac.slice(0, 12));
  const total = weights.reduce((a, b) => a + b, 0);
  const pick = (roll * BigInt(total)) >> 48n;
  let cum = 0n;
  for (let i = 0; i < weights.length; i++) {
    cum += BigInt(weights[i]!);
    if (cum > pick) return { hmac, index: i };
  }
  throw new Error('unreachable');
}

/** Sample size of the distribution test: 1,000,000 unless WHEEL_DIST_N says otherwise (>= 200,000). */
function distN(): number {
  const raw = process.env.WHEEL_DIST_N;
  if (raw === undefined || raw === '') return 1_000_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 200_000)
    throw new Error(`WHEEL_DIST_N must be an integer >= 200000, got "${raw}"`);
  return n;
}

const TABLE = table([
  seg('Jackpot', 5, 500),
  seg('Big', 15, 50),
  seg('Small', 30, 10),
  seg('Nothing', 50, 0),
]);
const WEIGHTS = TABLE.segments.map((s) => s.weight);

describe('wheel', () => {
  it('INV-WHEEL-DETERMINISTIC: the outcome is reproducible from seed, seed version, table and spin id', () => {
    for (let i = 0; i < 500; i++) {
      const spinId = randomUUID();
      const input = { seed: 'server-seed-v2', seedVersion: 2, spinId, table: TABLE };
      const a = selectSegment(input);
      const b = selectSegment(input);
      expect(b).toEqual(a);
      const o = oracle('server-seed-v2', spinId, WEIGHTS);
      expect(a.segmentIndex).toBe(o.index);
      expect(a.hmac).toBe(o.hmac);
      expect(a.segment.label).toBe(TABLE.segments[o.index]!.label);
    }
  });

  it('INV-WHEEL-DETERMINISTIC: a different seed or spin id gives a different hmac (not a constant)', () => {
    const base = { seed: 's1', seedVersion: 1, spinId: 'spin-1', table: TABLE };
    expect(selectSegment({ ...base, seed: 's2' }).hmac).not.toBe(selectSegment(base).hmac);
    expect(selectSegment({ ...base, spinId: 'spin-2' }).hmac).not.toBe(selectSegment(base).hmac);
  });

  it('INV-WHEEL-STORES-VERSIONS: the result carries the seed version, table version and hmac to store', () => {
    const r = selectSegment({
      seed: 's',
      seedVersion: 7,
      spinId: 'x',
      table: table(TABLE.segments, 9),
    });
    expect(r).toMatchObject({ seedVersion: 7, tableVersion: 9 });
    expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('INV-WHEEL-DISTRIBUTION: over WHEEL_DIST_N (default 1,000,000) spins each segment is within 0.5 pp of its weight share', () => {
    const counts = [0, 0, 0, 0];
    // MIO-063 asks for 1,000,000; WHEEL_DIST_N (positive integer, at least 200,000) lowers it on a
    // loaded machine. Deterministic either way (fixed seed, ids spin-0..). Default = 1,000,000.
    const N = distN();
    for (let i = 0; i < N; i++) {
      counts[
        selectSegment({ seed: 'dist-seed', seedVersion: 1, spinId: `spin-${i}`, table: TABLE })
          .segmentIndex
      ]!++;
    }
    const total = WEIGHTS.reduce((a, b) => a + b, 0);
    WEIGHTS.forEach((w, i) => {
      expect(Math.abs((counts[i]! / N - w / total) * 100)).toBeLessThan(0.5);
    });
  }, 120_000);

  it('INV-SPIN-RECOMPUTE-AFTER-ROTATION: the outcome is reproduced from the seed of the stored version, and the current seed would not reproduce it', () => {
    const SEEDS_BY_VERSION = new Map([
      [1, 'rotation-seed-v1'],
      [2, 'rotation-seed-v2'],
    ]);
    const stored = selectSegment({
      seed: SEEDS_BY_VERSION.get(1)!,
      seedVersion: 1,
      spinId: 'spin-before-rotation',
      table: TABLE,
    });
    // after the rotation the current version is 2; an audit looks the seed up by the STORED version
    const recomputed = selectSegment({
      seed: SEEDS_BY_VERSION.get(stored.seedVersion)!,
      seedVersion: stored.seedVersion,
      spinId: 'spin-before-rotation',
      table: TABLE,
    });
    expect(recomputed).toEqual(stored);
    const withCurrent = selectSegment({
      seed: SEEDS_BY_VERSION.get(2)!,
      seedVersion: 2,
      spinId: 'spin-before-rotation',
      table: TABLE,
    });
    expect(withCurrent.hmac).not.toBe(stored.hmac);
  });

  it('INV-WHEEL-WEIGHTS-SUM: probabilities are weight / total and sum to 1', () => {
    const p = probabilities(TABLE);
    expect(p).toEqual([0.05, 0.15, 0.3, 0.5]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('INV-WHEEL-REJECTS-BAD-TABLE: a corrupt table (zero, negative, fractional weight, empty) never yields a spin', () => {
    const base = { seed: 's', seedVersion: 1, spinId: 'x' };
    for (const bad of [
      table([seg('a', 0, 1), seg('b', 5, 1)]),
      table([seg('a', -1, 1), seg('b', 5, 1)]),
      table([seg('a', 1.5, 1)]),
      table([]),
    ]) {
      expect(() => selectSegment({ ...base, table: bad })).toThrow();
    }
    expect(() => probabilities(table([seg('a', 0, 1)]))).toThrow();
  });

  it('INV-WHEEL-PUBLIC-NO-WEIGHTS: the player view has labels only, no weights, seeds or versions', () => {
    const view = toPublicWheel(TABLE);
    expect(PublicWheel.safeParse(view).success).toBe(true);
    expect(view.segments.map((s) => s.label)).toEqual(['Jackpot', 'Big', 'Small', 'Nothing']);
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/weight|seed|version|probab/i);
  });
});
