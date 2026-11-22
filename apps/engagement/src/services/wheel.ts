import { createHmac } from 'node:crypto';
import { MAX_TOTAL_WEIGHT, type PublicWheel, type RewardSegment } from '@ex-mio/contracts';
import type { RewardTableVersion } from '../model/repositories';

/**
 * The wheel (docs/specs/engagement-ingest.md section 8). Pure functions, no clock, no randomness
 * but the HMAC of the server seed over the spin id:
 *   hmac    = HMAC-SHA256(key = seed, message = spinId), lower-case hex
 *   roll    = the first 6 bytes of the hmac as an integer, 0 .. 2^48 - 1
 *   pick    = floor(roll * totalWeight / 2^48)
 *   segment = the first segment whose cumulative weight is greater than `pick`
 */

export interface SelectInput {
  seed: string;
  seedVersion: number;
  spinId: string;
  table: RewardTableVersion;
}

export interface Selection {
  segmentIndex: number;
  segment: RewardSegment;
  hmac: string;
  seedVersion: number;
  tableVersion: number;
}

/** Throws on a corrupt table: no segment, a non-positive or fractional weight, a total too large. */
function totalWeight(segments: readonly RewardSegment[]): number {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('reward table has no segments');
  }
  let total = 0;
  for (const s of segments) {
    if (!Number.isInteger(s.weight) || s.weight <= 0) {
      throw new Error('reward table has a segment weight that is not a positive integer');
    }
    total += s.weight;
  }
  if (total > MAX_TOTAL_WEIGHT) throw new Error('reward table total weight is too large');
  return total;
}

export function selectSegment(input: SelectInput): Selection {
  const { table } = input;
  const total = totalWeight(table.segments);
  const hmac = createHmac('sha256', input.seed).update(input.spinId).digest('hex');
  const roll = BigInt(`0x${hmac.slice(0, 12)}`);
  const pick = (roll * BigInt(total)) >> 48n;
  let cumulative = 0n;
  for (let i = 0; i < table.segments.length; i += 1) {
    const segment = table.segments[i]!;
    cumulative += BigInt(segment.weight);
    if (cumulative > pick) {
      return {
        segmentIndex: i,
        segment,
        hmac,
        seedVersion: input.seedVersion,
        tableVersion: table.version,
      };
    }
  }
  throw new Error('unreachable: pick is below the total weight');
}

/** Each segment's weight divided by the total weight. */
export function probabilities(table: RewardTableVersion): number[] {
  const total = totalWeight(table.segments);
  return table.segments.map((s) => s.weight / total);
}

/** What a player may see of a wheel: the labels, in order. Never weights, seeds or versions. */
export function toPublicWheel(table: RewardTableVersion): PublicWheel {
  return {
    wheel_id: table.wheelId,
    segments: table.segments.map((s) => ({ label: s.label })),
  };
}
