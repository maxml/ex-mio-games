import { z } from 'zod';
import { Uuid } from './ids';

// Engagement ingest, rules and wheel contracts (spec: docs/specs/engagement-ingest.md).
// Money is always an integer in minor units. Every object a client or a casino sends is
// `.strict()`: an unknown field is an error, never ignored.

export const Currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case');

/** The only inbound event shape the rules, wheel and store code ever sees. */
export const CanonicalDepositEvent = z
  .object({
    tenant_id: Uuid,
    source: z.string().min(1).max(64),
    external_event_id: z.string().min(1).max(200),
    type: z.literal('deposit.succeeded'),
    external_player_id: z.string().min(1).max(200),
    amount_minor: z.number().int().positive().safe(),
    currency: Currency,
    occurred_at: z.string().datetime(),
  })
  .strict();
export type CanonicalDepositEvent = z.infer<typeof CanonicalDepositEvent>;

// ---- events -------------------------------------------------------------------

/**
 * Published through the outbox in the same transaction as the inbound_events row. X-1/D-12: it
 * carries only the internal `player_id` (resolved through identity before the outbox write), never
 * the casino's raw external player id. Strict: a stray `external_player_id` is a parse error.
 */
export const DepositConfirmedV1 = z.strictObject({
  inbound_event_id: Uuid,
  source: z.string().min(1),
  external_event_id: z.string().min(1),
  player_id: Uuid,
  amount_minor: z.number().int().positive().safe(),
  currency: Currency,
  occurred_at: z.string().datetime(),
});
export type DepositConfirmedV1 = z.infer<typeof DepositConfirmedV1>;

export const SpinGrantedV1 = z.object({
  credit_id: Uuid,
  player_id: Uuid,
  wheel_id: Uuid,
  source_event_id: Uuid,
});
export type SpinGrantedV1 = z.infer<typeof SpinGrantedV1>;

// ---- ingestion HTTP -----------------------------------------------------------

export const INGEST_ERROR_CODES = [
  'signature_missing', // 401
  'signature_invalid', // 401 (wrong secret, other tenant's secret, malformed signature)
  'stale', //            401 (valid signature, timestamp outside the window)
  'malformed_json', //   400
  'schema_invalid', //   422 (also: float amount)
  'unknown_tenant', //   404
  'tenant_suspended', // 402
] as const;
export const IngestErrorCode = z.enum(INGEST_ERROR_CODES);
export type IngestErrorCode = z.infer<typeof IngestErrorCode>;

export const INGEST_HTTP_STATUS: Record<IngestErrorCode, number> = {
  signature_missing: 401,
  signature_invalid: 401,
  stale: 401,
  malformed_json: 400,
  schema_invalid: 422,
  unknown_tenant: 404,
  tenant_suspended: 402,
};

export const IngestErrorBody = z.object({ message: z.string(), code: IngestErrorCode });
export type IngestErrorBody = z.infer<typeof IngestErrorBody>;

/**
 * 200 for a new event, a duplicate, or an ignored one. A duplicate returns exactly the body
 * of the first delivery. `inbound_event_id` is null only for `ignored`.
 */
export const IngestAck = z.object({
  status: z.enum(['accepted', 'ignored']),
  inbound_event_id: Uuid.nullable(),
});
export type IngestAck = z.infer<typeof IngestAck>;

/** Replay window for the casino's timestamp, in seconds (both directions). */
export const INGEST_TIMESTAMP_WINDOW_SECONDS = 300;

// ---- rules --------------------------------------------------------------------

export const RuleDefinition = z
  .object({
    name: z.string().trim().min(1).max(120),
    trigger: z.literal('deposit.succeeded'),
    conditions: z
      .object({
        min_amount_minor: z.number().int().nonnegative().safe(), // deposit >= X
        currency: Currency.optional(),
      })
      .strict(),
    action: z
      .object({
        type: z.literal('grant_spins'),
        spins: z.number().int().min(1).max(100),
        wheel_id: Uuid,
      })
      .strict(),
    active_from: z.string().datetime(),
    active_to: z.string().datetime().nullable(),
    max_grants_per_player: z.number().int().positive().nullable(),
  })
  .strict();
export type RuleDefinition = z.infer<typeof RuleDefinition>;

// ---- wheel --------------------------------------------------------------------

export const MAX_TOTAL_WEIGHT = 1_000_000;

export const RewardSegment = z
  .object({
    label: z.string().trim().min(1).max(60),
    weight: z.number().int().positive().max(MAX_TOTAL_WEIGHT),
    reward: z.discriminatedUnion('type', [
      z
        .object({ type: z.literal('coins'), amount: z.number().int().positive().max(1_000_000) })
        .strict(),
      z.object({ type: z.literal('nothing') }).strict(),
    ]),
  })
  .strict();
export type RewardSegment = z.infer<typeof RewardSegment>;

export const RewardTableDefinition = z
  .object({
    name: z.string().trim().min(1).max(120),
    segments: z.array(RewardSegment).min(1).max(50),
  })
  .strict()
  .refine((t) => t.segments.reduce((sum, s) => sum + s.weight, 0) <= MAX_TOTAL_WEIGHT, {
    message: `total weight must not exceed ${MAX_TOTAL_WEIGHT}`,
  });
export type RewardTableDefinition = z.infer<typeof RewardTableDefinition>;

/** What a player may send to spin: nothing but, optionally, which of their own credits. */
export const SpinRequest = z.object({ credit_id: Uuid.optional() }).strict();
export type SpinRequest = z.infer<typeof SpinRequest>;

export const SpinResponse = z
  .object({
    spin_id: Uuid,
    /** Index into the wheel's public segment list: the web wheel animates to the server's result. */
    segment_index: z.number().int().nonnegative(),
    segment_label: z.string(),
    reward_coins: z.number().int().nonnegative(),
  })
  .strict();
export type SpinResponse = z.infer<typeof SpinResponse>;

/** `GET /v1/me/spins`: how many spin credits the calling player can still use. Owner-only. */
export const MySpinsResponse = z
  .object({ available: z.number().int().nonnegative().safe() })
  .strict();
export type MySpinsResponse = z.infer<typeof MySpinsResponse>;

/**
 * The two reasons a spin is 409, and they must be told apart (D-3, review R2-5): `in_progress` is
 * a duplicate of an Idempotency-Key whose first request has not finished (the client retries with
 * the same key); `no_credit` means the player has nothing to spin (the client stops).
 */
export const SPIN_CONFLICT_CODES = ['in_progress', 'no_credit'] as const;
export const SpinConflictCode = z.enum(SPIN_CONFLICT_CODES);
export type SpinConflictCode = z.infer<typeof SpinConflictCode>;
export const SpinConflictBody = z.object({ message: z.string(), code: SpinConflictCode }).strict();
export type SpinConflictBody = z.infer<typeof SpinConflictBody>;

/** The wheel as a player sees it: labels only, never weights, seeds or versions. */
export const PublicWheel = z
  .object({
    wheel_id: Uuid,
    segments: z.array(z.object({ label: z.string() }).strict()).min(1),
  })
  .strict();
export type PublicWheel = z.infer<typeof PublicWheel>;
