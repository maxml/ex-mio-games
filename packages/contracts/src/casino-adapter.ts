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
    /**
     * D-12: required, never defaulted. A sandbox request is never sent to a production casino
     * endpoint and a production request never to a sandbox one; the adapter refuses a mismatch
     * with `rejected` before any I/O. Metering reads the same flag from the order.
     */
    sandbox: z.boolean(),
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

// ---- per tenant resolution (D-12) --------------------------------------------------------------

export const RECOVERY_MODES = ['native_lookup', 'idempotent_replay'] as const;
export const RecoveryMode = z.enum(RECOVERY_MODES);
export type RecoveryMode = z.infer<typeof RecoveryMode>;

/**
 * After the first issue attempt, a `not_found` from a status lookup is only final once this many
 * milliseconds have passed; before that it can be a casino that has not seen the request yet, and a
 * refund would double-pay (D-2). Bounds: one minute to seven days.
 */
export const ISSUE_DEADLINE_MS_MIN = 60_000;
export const ISSUE_DEADLINE_MS_MAX = 7 * 24 * 60 * 60 * 1000;
export const IssueDeadlineMs = z
  .number()
  .int()
  .min(ISSUE_DEADLINE_MS_MIN)
  .max(ISSUE_DEADLINE_MS_MAX);

/**
 * Per-tenant reward API settings, part of the tenant's integration credentials (identity; static
 * config in dev). `sandbox_base_url` has no fallback: a tenant without it has no sandbox port.
 */
export const CasinoRewardApiConfig = z
  .object({
    base_url: z.string().url(),
    api_key: z.string().min(1).optional(),
    sandbox_base_url: z.string().url().optional(),
    sandbox_api_key: z.string().min(1).optional(),
    /** Overrides the adapter type's default deadline. */
    issue_deadline_ms: IssueDeadlineMs.optional(),
  })
  .strict();
export type CasinoRewardApiConfig = z.infer<typeof CasinoRewardApiConfig>;

/** What a caller learns with the port; the saga reads it to decide how to recover and when to refund. */
export const ResolvedPortInfo = z
  .object({
    recovery_mode: RecoveryMode,
    issue_deadline_ms: IssueDeadlineMs,
    sandbox: z.boolean(),
  })
  .strict();
export type ResolvedPortInfo = z.infer<typeof ResolvedPortInfo>;

/** The reward side of a casino adapter. Neither method ever throws. */
export interface CasinoRewardPort {
  issueReward(request: RewardRequest, idempotencyKey: string): Promise<IssueResult>;
  /**
   * Looks up by OUR key. `request` is the frozen request the key was first used with: a casino
   * without a lookup by key (replay mode) is asked again with the same key and request.
   */
  getRewardStatus(idempotencyKey: string, request: RewardRequest): Promise<RewardStatus>;
}

/**
 * Note for every caller: on an `idempotent_replay` adapter `getRewardStatus` re-sends the issue, so
 * it can issue the reward. Call it only while the coins are still held, and treat `not_found` as
 * final only after `issue_deadline_ms` since the first issue attempt.
 */

/** A port resolved for one tenant and one environment. */
export interface ResolvedRewardPort {
  port: CasinoRewardPort;
  info: ResolvedPortInfo;
}

/**
 * The adapter registry per tenant (D-12). Resolves the adapter type and its settings from the
 * tenant's integration credentials. Resolves to `undefined` for an unknown tenant, a suspended
 * tenant, an unknown adapter type, a tenant without reward API settings, and `{sandbox: true}` for
 * a tenant without a sandbox endpoint (the production adapter is never the fallback for the
 * sandbox). A failing integration lookup (identity down) is NOT "absent": the promise rejects, so
 * a caller retries instead of reading it as "no adapter" and refunding.
 */
export interface CasinoRewardPorts {
  forTenant(tenantId: string, opts: { sandbox: boolean }): Promise<ResolvedRewardPort | undefined>;
}

/**
 * The casino's own id of one of our players. The identity player mapping is the only place the raw
 * id lives (MIO-107); the saga asks here instead of keeping a copy. `undefined` when there is no
 * mapping row, for example after an erasure.
 */
export interface CasinoPlayerPort {
  externalPlayerId(
    tenantId: string,
    userId: string,
  ): Promise<{ platform: string; external_player_id: string } | undefined>;
}

/**
 * Builds the frozen request for one order: the casino player id comes from the mapping, never from
 * the user id and never guessed. `undefined` when the player has no mapping.
 */
export interface RewardRequestBuilder {
  build(input: {
    tenantId: string;
    userId: string;
    reward: RewardRequest['reward'];
    sandbox: boolean;
  }): Promise<RewardRequest | undefined>;
}
