import { z } from 'zod';
import { Currency } from './ingest';

// The ONE casino reward port (coordinator decision D-2). Owned by the engagement-ingest epic;
// the redemption saga (store epic) imports it and defines no port of its own.
// Spec: docs/specs/engagement-ingest.md section 3. Types and schemas only, no behaviour.

/** What we ask a casino to issue. The idempotency key travels beside it, never inside it. */
export const RewardRequest = z
  .object({
    external_player_id: z.string().min(1).max(200),
    reward: z
      .object({
        type: z.string().min(1).max(64),
        amount_minor: z.number().int().positive().safe(),
        currency: Currency,
      })
      .strict(),
  })
  .strict();
export type RewardRequest = z.infer<typeof RewardRequest>;

/**
 * Outcome of one `issueReward` call. `unknown` means timeout or transport error: the casino may
 * or may not have issued the reward. It is not a failure and never leads to a refund by itself.
 */
export const IssueResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issued'), external_ref: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('pending'), external_ref: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('rejected'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export type IssueResult = z.infer<typeof IssueResult>;

/**
 * Outcome of a status lookup by OUR idempotency key. A lookup that times out or fails in
 * transport is `unknown`; it is never `not_found`, `rejected` or a throw.
 */
export const RewardStatus = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issued'), external_ref: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('pending'), external_ref: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('rejected'), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('not_found') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export type RewardStatus = z.infer<typeof RewardStatus>;

/** The reward side of a casino adapter. Neither method ever throws. */
export interface CasinoRewardPort {
  issueReward(request: RewardRequest, idempotencyKey: string): Promise<IssueResult>;
  /**
   * Looks up by OUR key. `request` is the frozen request the key was first used with: a casino
   * without a lookup by key (replay mode) is asked again with the same key and request.
   */
  getRewardStatus(idempotencyKey: string, request: RewardRequest): Promise<RewardStatus>;
}
