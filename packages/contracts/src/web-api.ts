import { z } from 'zod';

// Read models and requests the web app (player widget, operator console, platform admin) speaks.
// The web API client validates every response against these schemas, and the mock adapter is typed
// by them, so the mock and the real services cannot drift apart silently.
//
// Provisional until the owning services publish their final shapes: a service that changes one of
// these changes it here, in the same commit, with the contract test.

export const RedemptionStatus = z.enum(['pending', 'issuing', 'issued', 'failed', 'refunded']);
export type RedemptionStatus = z.infer<typeof RedemptionStatus>;

export const TenantStatus = z.enum(['trial', 'active', 'past_due', 'suspended']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const StoreItemKind = z.enum(['free_spins', 'cash_bonus', 'cashback', 'merch']);

/** One wheel segment as the player sees it: a label only. Odds are never sent to the widget. */
export const WheelSegmentView = z.object({ id: z.string(), label: z.string() });
export type WheelSegmentView = z.infer<typeof WheelSegmentView>;

export const StoreItemView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  priceCoins: z.number().int().positive(),
  /** Remaining stock; absent means unlimited. */
  stock: z.number().int().nonnegative().optional(),
  kind: StoreItemKind,
});
export type StoreItemView = z.infer<typeof StoreItemView>;

export const HistoryRowView = z.object({
  id: z.string(),
  at: z.string(),
  what: z.string(),
  delta: z.number().int(),
  /** Set on spin rows so the widget can hold a result back until the wheel stops. */
  spinId: z.string().optional(),
});
export type HistoryRowView = z.infer<typeof HistoryRowView>;

export const PlayerRedemptionView = z.object({
  id: z.string(),
  itemId: z.string(),
  item: z.string(),
  coins: z.number().int(),
  status: RedemptionStatus,
});
export type PlayerRedemptionView = z.infer<typeof PlayerRedemptionView>;

export const SpinResultView = z.object({
  /** Server spin id: a result is credited once per id. */
  id: z.string(),
  /** Index of the segment the SERVER picked. The client only animates to it. */
  index: z.number().int().nonnegative(),
  coins: z.number().int().nonnegative(),
});
export type SpinResultView = z.infer<typeof SpinResultView>;

export const PlayerState = z.object({
  coins: z.number().int().nonnegative(),
  spins: z.number().int().nonnegative(),
  wheel: z.array(WheelSegmentView).min(2),
  store: z.array(StoreItemView),
  history: z.array(HistoryRowView),
  redemptions: z.array(PlayerRedemptionView),
  lastSpin: SpinResultView.nullable(),
  /** Demo switch of the sandbox casino: fail the next reward. */
  casinoDown: z.boolean(),
});
export type PlayerState = z.infer<typeof PlayerState>;

export const RedeemRequest = z.object({ itemId: z.string().min(1) });
export type RedeemRequest = z.infer<typeof RedeemRequest>;

export const DepositResult = z.object({ granted: z.number().int().nonnegative() });
export type DepositResult = z.infer<typeof DepositResult>;

// --- operator console -------------------------------------------------------

export const OperatorStepId = z.enum([
  'signup',
  'plan',
  'keys',
  'sandbox',
  'golive',
  'rules',
  'wheel',
  'store',
  'redemptions',
  'billing',
]);
export type OperatorStepId = z.infer<typeof OperatorStepId>;

export const RulesView = z.object({
  min: z.number().int().positive(),
  spins: z.number().int().positive(),
  per: z.boolean(),
  cap: z.number().int().positive(),
});
export type RulesView = z.infer<typeof RulesView>;

export const PlanView = z.object({
  id: z.string(),
  name: z.string(),
  /** EUR per month. */
  price: z.number().int().nonnegative(),
  spins: z.string(),
  extra: z.string(),
});
export type PlanView = z.infer<typeof PlanView>;

export const PaymentAttemptView = z.object({
  id: z.string(),
  plan: z.string(),
  amount: z.number().nonnegative(),
  last4: z.string().length(4),
  status: z.enum(['processing', 'declined', 'cancelled', 'paid']),
});
export type PaymentAttemptView = z.infer<typeof PaymentAttemptView>;

export const WheelRewardView = z.object({
  id: z.string(),
  label: z.string(),
  coins: z.number().int().nonnegative(),
  weight: z.number().positive(),
});
export type WheelRewardView = z.infer<typeof WheelRewardView>;

export const WheelVersionView = z.object({
  version: z.number().int().positive(),
  state: z.enum(['draft', 'published', 'archived']),
  publishedAt: z.string(),
  note: z.string(),
});
export type WheelVersionView = z.infer<typeof WheelVersionView>;

export const CatalogItemView = StoreItemView.extend({ visible: z.boolean() });
export type CatalogItemView = z.infer<typeof CatalogItemView>;

export const OperatorRedemptionView = z.object({
  id: z.string(),
  player: z.string(),
  item: z.string(),
  coins: z.number().int(),
  status: RedemptionStatus,
  at: z.string(),
  note: z.string().optional(),
});
export type OperatorRedemptionView = z.infer<typeof OperatorRedemptionView>;

export const SandboxCheckView = z.object({ id: z.string(), label: z.string(), detail: z.string() });
export type SandboxCheckView = z.infer<typeof SandboxCheckView>;

export const InvoiceView = z.object({
  period: z.string(),
  paid: z.boolean(),
  plan: z.string(),
  total: z.number().nonnegative(),
  lines: z.array(
    z.object({ id: z.string(), item: z.string(), qty: z.string(), amount: z.number() }),
  ),
});
export type InvoiceView = z.infer<typeof InvoiceView>;

export const OperatorState = z.object({
  done: z.record(OperatorStepId, z.boolean()),
  accountCreated: z.boolean(),
  plans: z.array(PlanView),
  plan: z.string(),
  planActive: z.boolean(),
  invoicePaid: z.boolean(),
  cardLast4: z.string().nullable(),
  payment: PaymentAttemptView.nullable(),
  paidPlan: z.string().nullable(),
  paidAmount: z.number().nullable(),
  sandboxPassed: z.boolean(),
  sandboxChecks: z.array(SandboxCheckView),
  live: z.enum(['off', 'awaiting', 'live']),
  rules: RulesView,
  rulesSaved: z.boolean(),
  wheel: z.object({
    version: z.number().int().positive(),
    rewards: z.array(WheelRewardView),
    versions: z.array(WheelVersionView),
  }),
  catalog: z.array(CatalogItemView),
  redemptions: z.array(OperatorRedemptionView),
  usage: z.object({
    spinsThisMonth: z.number().int(),
    included: z.number().int(),
    activePlayers: z.number().int(),
    daily: z.array(z.number()),
  }),
  invoice: InvoiceView,
});
export type OperatorState = z.infer<typeof OperatorState>;

// --- platform admin ---------------------------------------------------------

export const AdminTenantRow = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.string(),
  status: TenantStatus,
  mrr: z.number().nonnegative(),
  spins: z.number().int().nonnegative(),
  depositors: z.number().int().nonnegative(),
  signup: z.string(),
});
export type AdminTenantRow = z.infer<typeof AdminTenantRow>;

export const AdminOverview = z.object({
  tenants: z.array(AdminTenantRow),
  funnel: z.array(z.object({ step: z.string(), value: z.number().int().nonnegative() })),
  /** Audited "act as tenant" entries, newest first. */
  audit: z.array(
    z.object({ id: z.string(), tenantId: z.string(), reason: z.string(), at: z.string() }),
  ),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

/** Opening an operator tenant needs a reason; the server writes the audit entry. */
export const ActAsTenantRequest = z.object({
  tenantId: z.string().min(1),
  reason: z.string().trim().min(8).max(500),
});
export type ActAsTenantRequest = z.infer<typeof ActAsTenantRequest>;
