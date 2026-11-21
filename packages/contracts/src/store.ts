import { z } from 'zod';
import { Uuid } from './ids';

// Bonus store and redemption saga contracts (engagement store).
// Spec: docs/specs/engagement-store.md. The coin reserve is the payments service's HTTP API and
// the casino port is `casino-adapter.ts`; this file defines neither.

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
  /** An operator `not_issued` that the casino's own answer does not back (decision D-2). */
  release_not_allowed: 409,
} as const;
export type StoreErrorCode = keyof typeof STORE_ERROR_CODES;

// There is no principal context here (X-9): role and `sandbox` come from the verified token through
// the service-kit `authOf(request)`, never from a header. Roles are identity's `Role` vocabulary.

// The coin reserve is NOT defined here: payments owns it (decisions D-1, D-9). The saga calls the
// payments internal HTTP API (`PAYMENTS_INTERNAL_ROUTES` in identity.ts, tenant in the path) and
// consumes none of its events. Rejection codes are payments' `PaymentsErrorCode` (X-5). The casino
// reward port lives in `casino-adapter.ts` (decision D-2). None is redefined in this file.

// ---- redemption events (engagement -> everyone)
// `sandbox` is on the event ENVELOPE (D-13, X-13), set through `createEvent`; never in the payload.

const RedemptionEventBase = z.object({
  redemption_id: Uuid,
  player_id: Uuid,
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
