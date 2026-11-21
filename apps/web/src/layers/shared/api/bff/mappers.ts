// Pure mapping from the service contracts (snake_case, minor units, service vocabulary) to the web read
// models the screens speak. Every function takes an already parsed service value, so a mapping bug is a
// unit test, not a browser session. Field map: contracts reconciliation §2.4 (W-1 ... W-10).
import type {
  AdminOverview,
  AuditEntry,
  BillingPlan,
  Invoice,
  InvoiceView,
  PaymentAttempt,
  PaymentAttemptView,
  PlanView,
  PlayerRedemptionView,
  Redemption,
  SpinResponse,
  SpinResultView,
  StoreItem,
  StoreItemView,
  UsageReport,
} from '../../types';

/** W-1: `spin_id -> id`, `segment_index -> index`, `reward_coins -> coins`. The balance is NOT in it (D-1). */
export const mapSpin = (r: SpinResponse): SpinResultView => ({
  id: r.spin_id,
  index: r.segment_index,
  coins: r.reward_coins,
});

const KINDS: Record<string, StoreItemView['kind']> = {
  free_spins: 'free_spins',
  freespins: 'free_spins',
  cash_bonus: 'cash_bonus',
  bonus: 'cash_bonus',
  cashback: 'cashback',
  merch: 'merch',
};

/** W-7: `price -> priceCoins`, `stock: null -> absent` (unlimited), `kind` from `reward.type`. */
export function mapItem(i: StoreItem): StoreItemView {
  const base: StoreItemView = {
    id: i.id,
    name: i.name,
    description: i.description,
    priceCoins: i.price,
    kind: KINDS[i.reward.type.toLowerCase()] ?? 'cash_bonus',
  };
  return i.stock === null ? base : { ...base, stock: i.stock };
}

/** W-5: the status word is the store's own `PublicRedemptionStatus`, passed through unchanged. */
export function mapRedemption(
  r: Redemption,
  items: ReadonlyMap<string, StoreItem>,
): PlayerRedemptionView {
  return {
    id: r.id,
    itemId: r.item_id,
    item: items.get(r.item_id)?.name ?? 'Item',
    coins: r.price,
    status: r.status,
  };
}

export const major = (minor: number): number => Math.round(minor) / 100;

/**
 * W-10: `price_minor / 100`. `spins` and `extra` have no source in L2 (known-gaps G-6). The view id is the
 * plan `code` ("starter", "growth"): stable, readable, and what the console already sends back. The BFF
 * resolves a code to L2's plan uuid before it calls payments.
 */
export const mapPlan = (p: BillingPlan): PlanView => ({
  id: p.code,
  name: p.name,
  price: Math.round(p.price_minor / 100),
  spins: '',
  extra: '',
});

/**
 * W-9: L2's lifecycle is `processing|succeeded|declined|cancelled`. The console's view word for a
 * successful attempt stays `paid` (the frozen engine tests pin it); the mapping is here and only here.
 */
export const VIEW_STATUS_OF_ATTEMPT = {
  processing: 'processing',
  succeeded: 'paid',
  declined: 'declined',
  cancelled: 'cancelled',
} as const satisfies Record<PaymentAttempt['state'], PaymentAttemptView['status']>;

export function mapAttempt(
  a: PaymentAttempt,
  plans: ReadonlyMap<string, BillingPlan>,
): PaymentAttemptView {
  return {
    id: a.id,
    plan: plans.get(a.plan_id)?.code ?? a.plan_id,
    amount: major(plans.get(a.plan_id)?.price_minor ?? 0),
    last4: a.card_last4,
    status: VIEW_STATUS_OF_ATTEMPT[a.state],
  };
}

export function mapInvoice(
  inv: Invoice | undefined,
  plan: BillingPlan | undefined,
): InvoiceView | null {
  if (!inv) return null;
  const total = major(inv.amount_minor);
  return {
    period: inv.period_start.slice(0, 7),
    paid: inv.status === 'paid',
    plan: plan?.code ?? inv.subscription_id,
    total,
    lines: [{ id: inv.id, item: `${plan?.name ?? 'Subscription'} plan`, qty: '1', amount: total }],
  };
}

/** W-10: `included` and `daily[]` have no source; they stay empty rather than invented. */
export const mapUsage = (u: UsageReport) => ({
  spinsThisMonth: u.spins,
  included: 0,
  activePlayers: u.monthly_active_players,
  daily: [] as number[],
});

/** W-13: the audit trail is the one platform read that exists (`GET /v1/audit`). */
export function mapAudit(entries: readonly AuditEntry[]): AdminOverview['audit'] {
  return entries
    .filter((e) => e.action === 'acting.request' || e.acting_tenant_id !== null)
    .map((e) => ({
      id: e.id,
      tenantId: e.acting_tenant_id ?? e.actor_tenant_id ?? '',
      reason: e.reason,
      at: e.occurred_at,
    }));
}
