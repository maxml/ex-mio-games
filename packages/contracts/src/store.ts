import { z } from 'zod';
import { Uuid } from './ids';

// Bonus store and redemption saga contracts (epic engagement-store).
// Spec: docs/specs/engagement-store.md. Coordinates with `payments` (hold
// commands and events) and the casino adapter (RewardAdapter) only through
// this file.

// ---- catalog ------------------------------------------------------------------

/** Reward in canonical form; the casino adapter translates it. */
export const RewardMapping = z.object({
  type: z.string().min(1).max(64),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type RewardMapping = z.infer<typeof RewardMapping>;

export const CreateItemRequest = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  image_url: z.string().url().optional(),
  /** Positive integer coins. A violation is HTTP 422 `item_price_invalid`, not a generic 400. */
  price: z.number(),
  reward: RewardMapping,
  stock: z.number().int().nonnegative().nullable().default(null),
  per_player_limit: z.number().int().positive().nullable().default(null),
  active: z.boolean().default(true),
});
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;

export const UpdateItemRequest = CreateItemRequest.partial();
export type UpdateItemRequest = z.infer<typeof UpdateItemRequest>;

export const StoreItem = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  image_url: z.string().nullable(),
  price: z.number().int().positive(),
  reward: RewardMapping,
  stock: z.number().int().nonnegative().nullable(),
  per_player_limit: z.number().int().positive().nullable(),
  active: z.boolean(),
  version: z.number().int().positive(),
});
export type StoreItem = z.infer<typeof StoreItem>;

// ---- redemption ---------------------------------------------------------------

export const REDEMPTION_STATUSES = [
  'REQUESTED',
  'RESERVED',
  'REJECTED_FUNDS',
  'ISSUING',
  'UNKNOWN',
  'ISSUED',
  'COMPLETED',
  'REJECTED',
  'RELEASED',
  'REFUNDED',
  'NEEDS_REVIEW',
] as const;
export const RedemptionState = z.enum(REDEMPTION_STATUSES);
export type RedemptionState = z.infer<typeof RedemptionState>;

/** What a player sees: the fine-grained state collapsed to four words. */
export const PublicRedemptionStatus = z.enum(['pending', 'issuing', 'issued', 'failed_refunded']);
export type PublicRedemptionStatus = z.infer<typeof PublicRedemptionStatus>;

/**
 * REQUESTED, RESERVED, UNKNOWN, NEEDS_REVIEW -> pending; ISSUING -> issuing;
 * ISSUED, COMPLETED -> issued; REJECTED_FUNDS, REJECTED, RELEASED, REFUNDED -> failed_refunded.
 */
export const PUBLIC_STATUS_OF: Readonly<Record<RedemptionState, PublicRedemptionStatus>> = {
  REQUESTED: 'pending',
  RESERVED: 'pending',
  UNKNOWN: 'pending',
  NEEDS_REVIEW: 'pending',
  ISSUING: 'issuing',
  ISSUED: 'issued',
  COMPLETED: 'issued',
  REJECTED_FUNDS: 'failed_refunded',
  REJECTED: 'failed_refunded',
  RELEASED: 'failed_refunded',
  REFUNDED: 'failed_refunded',
};

export const CreateRedemptionRequest = z.object({ item_id: Uuid }).strict();
export type CreateRedemptionRequest = z.infer<typeof CreateRedemptionRequest>;

export const RedemptionHistoryEntry = z.object({
  from: RedemptionState.nullable(),
  to: RedemptionState,
  cause: z.string(),
  at: z.string().datetime(),
});

export const Redemption = z.object({
  id: Uuid,
  item_id: Uuid,
  price: z.number().int().positive(),
  status: PublicRedemptionStatus,
  state: RedemptionState,
  attempts: z.number().int().nonnegative(),
  casino_reference: z.string().nullable(),
  /** Players never see the reason of NEEDS_REVIEW; operators do. */
  failure_reason: z.string().nullable(),
  history: z.array(RedemptionHistoryEntry),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Redemption = z.infer<typeof Redemption>;

export const ListRedemptionsQuery = z.object({ status: RedemptionState.optional() });
export const ResolveReviewRequest = z.object({
  outcome: z.enum(['issued', 'not_issued']),
  reason: z.string().trim().min(3).max(500),
});
export type ResolveReviewRequest = z.infer<typeof ResolveReviewRequest>;

/** Stable machine-readable error codes returned in `ErrorBody.code`. */
export const STORE_ERROR_CODES = {
  item_price_invalid: 422,
  item_not_found: 404,
  item_inactive: 409,
  out_of_stock: 409,
  limit_reached: 409,
  insufficient_funds: 409,
  idempotency_key_reused: 422,
  idempotency_in_progress: 409,
  redemption_not_found: 404,
  forbidden: 403,
  illegal_transition: 409,
} as const;
export type StoreErrorCode = keyof typeof STORE_ERROR_CODES;

/**
 * Placeholder request context until the identity epic issues verified claims.
 * `sandbox` is set by the SERVER from the verifying key in the real system; it
 * is never read from a request body.
 */
export const PrincipalHeaders = z.object({
  'x-principal-id': z.string().min(1),
  'x-principal-role': z.enum(['player', 'owner', 'admin', 'analyst']).default('player'),
  'x-sandbox': z.enum(['0', '1']).default('0'),
});

// ---- hold commands (engagement -> payments) and hold events (payments -> engagement)

const HoldCommandBase = z.object({
  /** `hold:{id}`, `capture:{id}`, `release:{id}` or `refund:{id}`: the idempotency key of the phase. */
  operation_id: z.string().min(1),
  redemption_id: Uuid,
  player_id: z.string().min(1),
  sandbox: z.boolean(),
});
export const PlaceHoldV1 = HoldCommandBase.extend({ amount: z.number().int().positive() });
export const CaptureHoldV1 = HoldCommandBase;
export const ReleaseHoldV1 = HoldCommandBase;
export const RefundCaptureV1 = HoldCommandBase;

const HoldEventBase = z.object({
  redemption_id: Uuid,
  player_id: z.string().min(1),
  sandbox: z.boolean(),
});
export const HoldPlacedV1 = HoldEventBase.extend({ amount: z.number().int().positive() });
export const HoldRejectedV1 = HoldEventBase.extend({ reason: z.enum(['insufficient_funds']) });
export const HoldCapturedV1 = HoldEventBase;
export const HoldReleasedV1 = HoldEventBase;
export const CaptureRefundedV1 = HoldEventBase;
export const HoldCommandRejectedV1 = HoldEventBase.extend({
  command: z.enum(['place', 'capture', 'release', 'refund']),
  reason: z.enum([
    'hold_already_captured',
    'hold_already_released',
    'hold_not_captured',
    'hold_not_found',
  ]),
});

// ---- redemption events (engagement -> everyone; `sandbox` excludes it from metering)

const RedemptionEventBase = z.object({
  redemption_id: Uuid,
  player_id: z.string().min(1),
  sandbox: z.boolean(),
});
export const RedemptionStatusChangedV1 = RedemptionEventBase.extend({
  from: RedemptionState.nullable(),
  to: RedemptionState,
  cause: z.string(),
});
export const RedemptionIssuedV1 = RedemptionEventBase.extend({
  casino_reference: z.string(),
  price: z.number().int().positive(),
});
export const RedemptionRejectedV1 = RedemptionEventBase.extend({ reason: z.string() });
export const RedemptionNeedsReviewV1 = RedemptionEventBase.extend({ reason: z.string() });

// ---- casino adapter port (implemented by the integrations module, epic ingest) ----

export interface IssueRewardRequest {
  /** `redeem:{redemption_id}`: identical on every attempt of one redemption. */
  idempotencyKey: string;
  playerId: string;
  /** The reward mapping frozen on the order, never the live catalog entry. */
  reward: RewardMapping;
}

/**
 * The adapter classifies; it never throws for a classified failure. `rejected`
 * is returned only for a code on the adapter's FINAL list; anything else
 * (timeout, 5xx, network, 429, unparseable, unknown code) is `unknown`.
 * A thrown error is treated by the saga as `unknown` too.
 */
export type IssueRewardResult =
  | { outcome: 'issued'; reference: string }
  | { outcome: 'rejected'; code: string }
  | { outcome: 'unknown'; detail: string };

export type RewardStatusResult =
  | { outcome: 'issued'; reference: string }
  | { outcome: 'rejected'; code: string }
  | { outcome: 'not_found' }
  | { outcome: 'unknown'; detail: string };

export interface RewardAdapter {
  issueReward(req: IssueRewardRequest): Promise<IssueRewardResult>;
  /** Lookup by OUR key, so recovery works when the casino's reference was in a lost reply. */
  getRewardStatus(idempotencyKey: string): Promise<RewardStatusResult>;
}
