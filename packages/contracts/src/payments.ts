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
  /** X-10: a token carrying `act` on a coin route. Same meaning as identity's ACTING_FORBIDDEN, lower-case like every payments code. */
  acting_forbidden: 403,
  reserve_not_found: 404,
  wallet_not_found: 404,
  insufficient_funds: 409,
  /** Rejection codes of a conflicting reserve transition (D-9). L4 adopts these names. */
  reserve_already_captured: 409,
  reserve_already_released: 409,
  reserve_already_refunded: 409,
  reserve_not_captured: 409,
  /** Same business operation id (spin or reserve) replayed with different parameters. */
  operation_conflict: 409,
  idempotency_in_progress: 409,
  idempotency_key_reused: 422,
  /** Billing webhook whose signature does not verify. */
  invalid_signature: 401,
  attempt_not_found: 404,
  /** Cancel of an attempt that already succeeded or was declined. */
  attempt_not_cancellable: 409,
  /** A card number that is not one of the provider's test cards (fake provider). */
  card_not_accepted: 422,
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

// There is no credit command: spin coins arrive through the inbox as `engagement.spin.completed`
// (D-1), never over HTTP. The four commands below are the whole HTTP coin surface.

export const ReserveCoinsRequest = z
  .object({
    player_id: Uuid,
    /** Explicit, caller-chosen id of the reservation (the redemption id). */
    reserve_id: Uuid,
    amount: CoinAmount,
    currency: CoinCurrency.default(COIN_CURRENCY),
    /**
     * X-4/D-13: which wallet the hold is placed on. Required, no default. Legal because the route is
     * service-token only and engagement sets it from its server-side auth context, never from a
     * client. Capture, release and refund use the reserve's own wallet.
     */
    sandbox: z.boolean(),
  })
  .strict();
export type ReserveCoinsRequest = z.infer<typeof ReserveCoinsRequest>;

/**
 * Capture, release and refund name the reserve in the PATH (`:reserveId`, X-4) and carry an empty
 * body: the amount is always the reserve's own, so any field (an `amount`, a `tenant_id`) is a 400.
 */
export const ReserveRefRequest = z.object({}).strict();
export type ReserveRefRequest = z.infer<typeof ReserveRefRequest>;
export const ReserveIdParam = z.object({ reserveId: Uuid }).strict();

/** The HTTP commands (internal routes: `PAYMENTS_INTERNAL_ROUTES` in identity.ts). */
export const COIN_COMMANDS = ['reserve', 'capture', 'release', 'refund'] as const;
export type CoinCommand = (typeof COIN_COMMANDS)[number];

export const COIN_OPERATION_TYPES = ['credit', 'reserve', 'capture', 'release', 'refund'] as const;
export type CoinOperationType = (typeof COIN_OPERATION_TYPES)[number];

/**
 * Every action that changes the value of a coin balance (D-5). A token that carries
 * `acting_tenant` (an operator acting inside a tenant) is refused for all of them.
 * Adding an action here without adding its guard test fails the pin test.
 */
export const COIN_VALUE_ACTIONS = ['credit', 'reserve', 'capture', 'release', 'refund'] as const;

/**
 * What a command does to a reserve in each state (D-9). `replay`: the transition was already
 * applied, so the stored result is returned (even under a new HTTP key). Anything else is the
 * rejection code of a conflicting transition. `reserve_not_found` is for a missing reserve.
 */
export const RESERVE_COMMAND_OUTCOMES = {
  reserved: {
    capture: 'apply',
    release: 'apply',
    refund: 'reserve_not_captured',
  },
  captured: {
    capture: 'replay',
    release: 'reserve_already_captured',
    refund: 'apply',
  },
  released: {
    capture: 'reserve_already_released',
    release: 'replay',
    refund: 'reserve_already_released',
  },
  refunded: {
    capture: 'reserve_already_refunded',
    release: 'reserve_already_refunded',
    refund: 'replay',
  },
} as const;

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

// Internal routes are `PAYMENTS_INTERNAL_ROUTES` in identity.ts (tenant in the path, service token
// with aud=payments, caller allow-list `svc:engagement`). There are no header placeholders: identity
// is the only source of the principal, the acting claim (`act`) and the environment (`sbx`) (X-9).

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

/** `pending` until a verified provider webhook says otherwise (MIO-093); `declined` is a synchronous refusal. */
export const SUBSCRIPTION_STATUSES = [
  'pending',
  'active',
  'past_due',
  'declined',
  'canceled',
] as const;
export const Subscription = z.object({
  id: Uuid,
  plan_id: Uuid,
  status: z.enum(SUBSCRIPTION_STATUSES),
  provider: z.string(),
  provider_subscription_id: z.string(),
  /** Version of the last provider snapshot applied; an older snapshot never overwrites it. */
  provider_version: z.number().int().nonnegative(),
  current_period_start: z.string().datetime(),
  current_period_end: z.string().datetime(),
});
export type Subscription = z.infer<typeof Subscription>;

/**
 * D-27: `GET /v1/operator/plan`. The operator's current plan and the provider's own subscription id,
 * which the provider's callbacks carry, so nobody has to read it from the database.
 */
export const OperatorPlan = z
  .object({
    subscription_id: Uuid,
    status: z.enum(SUBSCRIPTION_STATUSES),
    plan: z.object({ id: Uuid, code: z.string().min(1), name: z.string().min(1) }).strict(),
    provider: z.string(),
    provider_subscription_id: z.string(),
    current_period_end: z.string().datetime(),
  })
  .strict();
export type OperatorPlan = z.infer<typeof OperatorPlan>;

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
    /**
     * A provider token, never a card number (a PAN must not enter our API or our stored request
     * hashes). The `fake` provider: `tok_4242` is accepted, `tok_0002` is declined.
     */
    payment_method: z.string().regex(/^tok_[a-z0-9_]{3,64}$/),
  })
  .strict();
export type SubscribeRequest = z.infer<typeof SubscribeRequest>;

/** What a verified provider webhook says about one subscription at one provider version. */
export const PROVIDER_SNAPSHOT_STATUSES = ['active', 'past_due', 'canceled'] as const;
export const ProviderSnapshot = z.object({
  eventId: z.string().min(1),
  /** Set by us at subscribe time and echoed by the provider (metadata); never read from elsewhere. */
  tenantId: Uuid,
  subscriptionId: z.string().min(1),
  status: z.enum(PROVIDER_SNAPSHOT_STATUSES),
  /** Monotonic per subscription (the provider's sequence); the order of events is NOT the order of versions. */
  version: z.number().int().positive(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});
export type ProviderSnapshot = z.infer<typeof ProviderSnapshot>;

export const WebhookResult = z.object({
  /** `ignored`: a callback for a cancelled payment attempt; recorded, changes nothing. */
  outcome: z.enum(['applied', 'superseded', 'duplicate', 'ignored']),
});

// ---- payment attempt (operator checkout lifecycle) -----------------------------------

export const PAYMENT_ATTEMPT_STATES = ['processing', 'succeeded', 'declined', 'cancelled'] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

/**
 * Allowed moves. `processing` is the only state that can change; a cancelled attempt never
 * succeeds, whatever the provider later says.
 */
export const ALLOWED_ATTEMPT_TRANSITIONS: Record<
  PaymentAttemptState,
  readonly PaymentAttemptState[]
> = {
  processing: ['succeeded', 'declined', 'cancelled'],
  succeeded: [],
  declined: [],
  cancelled: [],
};

/**
 * The card number is accepted ONLY here, only for the provider's test cards, and is never stored or
 * hashed: the attempt keeps `card_last4` and `card_brand`. Idempotency hashes the request without it.
 */
export const CreateAttemptRequest = z
  .object({
    plan_id: Uuid,
    card_number: z.string().regex(/^\d{12,19}$/),
  })
  .strict();
export type CreateAttemptRequest = z.infer<typeof CreateAttemptRequest>;

export const CARD_BRANDS = ['visa', 'mastercard'] as const;
export const PaymentAttempt = z.object({
  id: Uuid,
  plan_id: Uuid,
  subscription_id: Uuid.nullable(),
  state: z.enum(PAYMENT_ATTEMPT_STATES),
  card_last4: z.string().regex(/^\d{4}$/),
  card_brand: z.enum(CARD_BRANDS),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type PaymentAttempt = z.infer<typeof PaymentAttempt>;
export type WebhookResult = z.infer<typeof WebhookResult>;

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
      /** `balance_drift`: the account. Otherwise null. */
      account_id: Uuid.nullable(),
      /** `reserve_state_drift` (including an orphan hold): the reserve. Otherwise null. */
      reserve_id: Uuid.nullable(),
      /** `unbalanced_transaction`: the journal transaction. Otherwise null. */
      transaction_id: Uuid.nullable(),
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
