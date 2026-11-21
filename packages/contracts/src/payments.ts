import { z } from 'zod';
import { Uuid } from './ids';

// Payments contracts: coin ledger commands, balance read, billing, errors.
// Specification: docs/specs/payments.md. Only the `payments` service writes coins;
// every other service reads a balance and sends commands as a service identity.

// ---- money ------------------------------------------------------------------
// Coins are integers (minor units, no fractions). `z.number()` rejects strings,
// `.int()` rejects 1.5, `.positive()` rejects 0 and negatives, `.max()` the overflow.

export const COIN_CURRENCY = 'COIN' as const;
export const MAX_COIN_AMOUNT = 1_000_000_000_000;

export const CoinAmount = z.number().int().positive().max(MAX_COIN_AMOUNT);
export const CoinCurrency = z.literal(COIN_CURRENCY);

// ---- error codes ------------------------------------------------------------

export const PAYMENTS_ERROR_CODES = {
  validation_failed: 400,
  idempotency_key_required: 400,
  forbidden: 403,
  reserve_not_found: 404,
  wallet_not_found: 404,
  insufficient_funds: 409,
  invalid_reserve_transition: 409,
  /** Same business operation id (spin or reserve) replayed with different parameters. */
  operation_conflict: 409,
  idempotency_in_progress: 409,
  idempotency_key_reused: 422,
} as const;
export type PaymentsErrorCode = keyof typeof PAYMENTS_ERROR_CODES;

export const PaymentsErrorBody = z.object({
  code: z.enum(Object.keys(PAYMENTS_ERROR_CODES) as [PaymentsErrorCode, ...PaymentsErrorCode[]]),
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
});
export type PaymentsErrorBody = z.infer<typeof PaymentsErrorBody>;

// ---- coin commands (internal: service identity only) -------------------------
// Strict objects: an unknown field (for example `amount` on capture) is a 400.

export const CreditCoinsRequest = z
  .object({
    player_id: Uuid,
    /** The business operation: the spin that earned the coins. One award per spin. */
    spin_id: Uuid,
    amount: CoinAmount,
    currency: CoinCurrency.default(COIN_CURRENCY),
  })
  .strict();
export type CreditCoinsRequest = z.infer<typeof CreditCoinsRequest>;

export const ReserveCoinsRequest = z
  .object({
    player_id: Uuid,
    /** Explicit, caller-chosen id of the reservation (the redemption id). */
    reserve_id: Uuid,
    amount: CoinAmount,
    currency: CoinCurrency.default(COIN_CURRENCY),
  })
  .strict();
export type ReserveCoinsRequest = z.infer<typeof ReserveCoinsRequest>;

/** Capture, release and refund name a reserve; the amount is always the reserve's own. */
export const ReserveRefRequest = z.object({ reserve_id: Uuid }).strict();
export type ReserveRefRequest = z.infer<typeof ReserveRefRequest>;

export const COIN_OPERATION_TYPES = ['credit', 'reserve', 'capture', 'release', 'refund'] as const;
export type CoinOperationType = (typeof COIN_OPERATION_TYPES)[number];

export const WalletBalance = z.object({
  wallet_id: Uuid,
  available: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  currency: CoinCurrency,
});
export type WalletBalance = z.infer<typeof WalletBalance>;

export const CoinOperationResult = z.object({
  transaction_id: Uuid,
  operation: z.enum(COIN_OPERATION_TYPES),
  reserve_id: Uuid.nullable(),
  amount: CoinAmount,
  currency: CoinCurrency,
  balance: WalletBalance,
});
export type CoinOperationResult = z.infer<typeof CoinOperationResult>;

/** Reserve life cycle. `reserved` is the only state that accepts capture or release. */
export const RESERVE_STATES = ['reserved', 'captured', 'released', 'refunded'] as const;
export type ReserveState = (typeof RESERVE_STATES)[number];

export const ALLOWED_RESERVE_TRANSITIONS: Record<ReserveState, readonly ReserveState[]> = {
  reserved: ['captured', 'released'],
  captured: ['refunded'],
  released: [],
  refunded: [],
};

/** Internal-command headers (placeholder until the identity token lands). */
export const HEADER_SERVICE_ID = 'x-service-id';
export const HEADER_SERVICE_TOKEN = 'x-service-token';
/** `player` or `operator`; placeholder until the verified token claim replaces it. */
export const HEADER_PRINCIPAL_KIND = 'x-principal-kind';

// ---- balance read (read from anywhere) ----------------------------------------

export const PlayerIdParam = z.object({ player_id: Uuid });

// ---- billing (operator subscriptions) -------------------------------------------

export const BillingPlan = z.object({
  id: Uuid,
  code: z.string().min(1),
  name: z.string().min(1),
  interval: z.literal('month'),
  /** Integer minor units (cents). Never a float. */
  price_minor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type BillingPlan = z.infer<typeof BillingPlan>;

export const SUBSCRIPTION_STATUSES = ['active', 'declined', 'canceled'] as const;
export const Subscription = z.object({
  id: Uuid,
  plan_id: Uuid,
  status: z.enum(SUBSCRIPTION_STATUSES),
  provider: z.string(),
  provider_subscription_id: z.string(),
  current_period_start: z.string().datetime(),
  current_period_end: z.string().datetime(),
});
export type Subscription = z.infer<typeof Subscription>;

export const INVOICE_STATUSES = ['paid', 'failed'] as const;
export const Invoice = z.object({
  id: Uuid,
  subscription_id: Uuid,
  amount_minor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.enum(INVOICE_STATUSES),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
});
export type Invoice = z.infer<typeof Invoice>;

export const SubscribeRequest = z
  .object({
    plan_id: Uuid,
    /** Test card for the `fake` provider: ends in 4242 = ok, 0002 = declined. */
    card_number: z.string().regex(/^\d{12,19}$/),
  })
  .strict();
export type SubscribeRequest = z.infer<typeof SubscribeRequest>;

// ---- usage metering ---------------------------------------------------------------

export const UsageReport = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  spins: z.number().int().nonnegative(),
  monthly_active_players: z.number().int().nonnegative(),
});
export type UsageReport = z.infer<typeof UsageReport>;

// ---- reconciliation ---------------------------------------------------------------

export const RECONCILIATION_MISMATCH_KINDS = [
  'balance_drift',
  'unbalanced_transaction',
  'reserve_state_drift',
] as const;

export const ConservationReport = z.object({
  issued: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  captured: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
  refunded: z.number().int().nonnegative(),
  /** issued = available + held + captured - refunded */
  holds: z.boolean(),
});
export type ConservationReport = z.infer<typeof ConservationReport>;

export const ReconciliationRun = z.object({
  id: Uuid,
  status: z.enum(['ok', 'mismatch', 'failed']),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  accounts_checked: z.number().int().nonnegative(),
  mismatches: z.array(
    z.object({
      kind: z.enum(RECONCILIATION_MISMATCH_KINDS),
      account_id: Uuid.nullable(),
      expected: z.number().int().nullable(),
      actual: z.number().int().nullable(),
    }),
  ),
  report: ConservationReport.nullable(),
});
export type ReconciliationRun = z.infer<typeof ReconciliationRun>;

// ---- events -------------------------------------------------------------------------
// `payments.coins.credited` (CoinsCreditedV1) already lives in events.ts and is unchanged:
// its `credit_id` is the journal transaction id. These are the other phases.

const CoinMovement = {
  transaction_id: Uuid,
  player_id: Uuid,
  wallet_id: Uuid,
  reserve_id: Uuid,
  amount: CoinAmount,
  available_after: z.number().int().nonnegative(),
  held_after: z.number().int().nonnegative(),
};

export const CoinsReservedV1 = z.object(CoinMovement);
export const CoinsCapturedV1 = z.object(CoinMovement);
export const CoinsReleasedV1 = z.object(CoinMovement);
/** Not in the epic's four, but a refund changes a balance: projections must hear about it. */
export const CoinsRefundedV1 = z.object(CoinMovement);
