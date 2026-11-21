// One in-memory mock "backend" shared by the three screens. Everything that moves money or odds
// goes through this pure reducer, so the rules live in one place and are unit-tested:
//
//   - A spin is a server-decided result with an id. `player/spin` credits it at most once per id,
//     no matter how often the action is replayed or which component is mounted. The wheel only
//     animates a result that already exists; it never credits anything.
//   - Operator changes (rules, published weights, catalog) are state here, so the player widget
//     reads the same values.
import type { StoreItemView as StoreItem } from '../../../types';
import {
  PLAYER_HISTORY,
  PLANS,
  STORE_ITEMS,
  expectedPayout,
  WHEEL_REWARDS,
  WHEEL_VERSIONS,
  type Status,
  type WheelVersion,
} from './data';

/** The fake payment provider declines the test card ending in this. The decision lives in the reducer, not on a page. */
export const DECLINED_LAST4 = '0002';
export interface Payment {
  id: string;
  /** Plan and amount the attempt was started for. They never change afterwards. */
  plan: string;
  amount: number;
  last4: string;
  status: 'processing' | 'declined' | 'cancelled' | 'paid';
}

export type StepId =
  | 'signup'
  | 'plan'
  | 'keys'
  | 'sandbox'
  | 'golive'
  | 'rules'
  | 'wheel'
  | 'store'
  | 'redemptions'
  | 'billing';
export const STEPS: { id: StepId; label: string }[] = [
  { id: 'signup', label: 'Sign up' },
  { id: 'plan', label: 'Plan' },
  { id: 'keys', label: 'Keys' },
  { id: 'sandbox', label: 'Sandbox test' },
  { id: 'golive', label: 'Go live' },
  { id: 'rules', label: 'Rules' },
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Store' },
  { id: 'redemptions', label: 'Redemptions' },
  { id: 'billing', label: 'Usage & invoice' },
];

export interface Rules {
  min: number;
  spins: number;
  per: boolean;
  cap: number;
}
export interface HistoryRow {
  id: string;
  at: string;
  what: string;
  delta: number;
  /** Set on spin rows so a view can hide a result until its animation has finished. */
  spinId?: string;
}
export interface MyRedemption {
  id: string;
  itemId: string;
  item: string;
  coins: number;
  status: Status;
}
export interface CatalogItem extends StoreItem {
  visible: boolean;
}
export type LiveState = 'off' | 'awaiting' | 'live';

export interface State {
  player: {
    coins: number;
    spins: number;
    grantedToday: number;
    history: HistoryRow[];
    /** Ids of spins already credited. A spin id can be credited once, ever. */
    creditedSpins: string[];
    lastSpin: { id: string; index: number; coins: number } | null;
    redemptions: MyRedemption[];
    casinoDown: boolean;
  };
  operator: {
    step: number;
    done: Record<StepId, boolean>;
    accountCreated: boolean;
    plan: string;
    planActive: boolean;
    invoicePaid: boolean;
    cardLast4: string | null;
    /** Latest payment attempt, and what the paid invoice is really for. */
    payment: Payment | null;
    paidPlan: string | null;
    paidAmount: number | null;
    sandboxPassed: boolean;
    live: LiveState;
    rules: Rules;
    rulesSaved: boolean;
    wheel: { version: number; weights: number[]; versions: WheelVersion[] };
    catalog: CatalogItem[];
  };
}

export const DEFAULT_RULES: Rules = { min: 20, spins: 1, per: true, cap: 10 };

export function createInitialState(): State {
  const done = Object.fromEntries(STEPS.map((s) => [s.id, false])) as Record<StepId, boolean>;
  return {
    player: {
      coins: 420,
      spins: 3,
      grantedToday: 0,
      history: PLAYER_HISTORY.map((h) => ({ ...h })),
      creditedSpins: [],
      lastSpin: null,
      redemptions: [],
      casinoDown: false,
    },
    operator: {
      step: 0,
      done,
      accountCreated: false,
      plan: 'growth',
      planActive: false,
      invoicePaid: false,
      cardLast4: null,
      payment: null,
      paidPlan: null,
      paidAmount: null,
      sandboxPassed: false,
      live: 'off',
      rules: { ...DEFAULT_RULES },
      rulesSaved: false,
      wheel: {
        version: WHEEL_VERSIONS[0]?.version ?? 1,
        weights: WHEEL_REWARDS.map((r) => r.weight),
        versions: WHEEL_VERSIONS.map((v) => ({ ...v })),
      },
      catalog: STORE_ITEMS.map((i) => ({ ...i, visible: true })),
    },
  };
}

export type Action =
  | { type: 'player/spin'; id: string; index: number }
  | { type: 'player/deposit'; eur: number }
  | { type: 'player/casinoDown'; on: boolean }
  | { type: 'redeem/start'; id: string; itemId: string }
  | { type: 'redeem/status'; id: string; status: Status }
  | { type: 'redeem/refund'; id: string }
  | { type: 'step/set'; step: number }
  | { type: 'step/complete'; id: StepId }
  | { type: 'account/create' }
  | { type: 'plan/select'; id: string }
  | { type: 'payment/start'; id: string; plan: string; last4: string }
  | { type: 'payment/cancel'; id: string }
  | { type: 'payment/settle'; id: string }
  | { type: 'sandbox/pass' }
  | { type: 'live/start' }
  | { type: 'live/deposit' }
  | { type: 'rules/save'; rules: Rules }
  | { type: 'wheel/publish'; weights: number[]; at?: string }
  | { type: 'catalog/price'; id: string; price: number }
  | { type: 'catalog/visible'; id: string; on: boolean };

/** Deposit rule: how many spins a deposit earns (before the daily cap). */
export function spinsForDeposit(r: Rules, eur: number): number {
  return r.per ? Math.floor(eur / r.min) * r.spins : eur >= r.min ? r.spins : 0;
}
export const rulesValid = (r: Rules): boolean =>
  [r.min, r.spins, r.cap].every((n) => Number.isInteger(n) && n >= 1);
export const weightsValid = (w: number[]): boolean =>
  w.length === WHEEL_REWARDS.length && w.every((x) => Number.isFinite(x) && x > 0);
export const sameWeights = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Server stand-in: picks a segment by weight using the PUBLISHED weights. `rnd` is in [0, 1). */
export function pickReward(weights: number[], rnd: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rnd * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i] ?? 0;
    if (x < 0) return i;
  }
  return 0;
}

/** Index of the largest coin reward (the "top prize"), for odds copy. */
export const TOP_PRIZE_INDEX = WHEEL_REWARDS.reduce(
  (best, r, i, all) => (r.coins > (all[best]?.coins ?? 0) ? i : best),
  0,
);

const row = (id: string, what: string, delta: number, spinId?: string): HistoryRow => ({
  id,
  at: 'Just now',
  what,
  delta,
  spinId,
});

export function reducer(s: State, a: Action): State {
  const p = s.player;
  const o = s.operator;
  const patchP = (x: Partial<State['player']>): State => ({ ...s, player: { ...p, ...x } });
  const patchO = (x: Partial<State['operator']>): State => ({ ...s, operator: { ...o, ...x } });
  const complete = (...ids: StepId[]) => ({
    ...o.done,
    ...Object.fromEntries(ids.map((i) => [i, true])),
  });

  switch (a.type) {
    case 'player/spin': {
      const reward = WHEEL_REWARDS[a.index];
      // Choke point: an id that was already credited, or no spin left, changes nothing.
      if (!reward || p.spins < 1 || p.creditedSpins.includes(a.id)) return s;
      return patchP({
        spins: p.spins - 1,
        coins: p.coins + reward.coins,
        creditedSpins: [...p.creditedSpins, a.id],
        lastSpin: { id: a.id, index: a.index, coins: reward.coins },
        history: [
          row(`h-${a.id}`, `Spin: landed on ${reward.coins}`, reward.coins, a.id),
          ...p.history,
        ],
      });
    }
    case 'player/deposit': {
      const granted = Math.max(
        0,
        Math.min(spinsForDeposit(o.rules, a.eur), o.rules.cap - p.grantedToday),
      );
      const what =
        granted > 0
          ? `Deposit ${a.eur} EUR earned ${granted} ${granted === 1 ? 'spin' : 'spins'}`
          : `Deposit ${a.eur} EUR: no spins (below the minimum or daily cap reached)`;
      return patchP({
        spins: p.spins + granted,
        grantedToday: p.grantedToday + granted,
        history: [row(`h-dep-${p.history.length}-${p.grantedToday}`, what, 0), ...p.history],
      });
    }
    case 'player/casinoDown':
      return patchP({ casinoDown: a.on });
    case 'redeem/start': {
      const item = o.catalog.find((i) => i.id === a.itemId);
      if (!item || !item.visible || (item.stock !== undefined && item.stock <= 0)) return s;
      if (p.coins < item.priceCoins || p.redemptions.some((r) => r.id === a.id)) return s;
      return patchP({
        coins: p.coins - item.priceCoins, // held at once; refunded if issuing fails
        redemptions: [
          { id: a.id, itemId: item.id, item: item.name, coins: item.priceCoins, status: 'pending' },
          ...p.redemptions,
        ],
        history: [row(`h-${a.id}`, `Redeemed ${item.name}`, -item.priceCoins), ...p.history],
      });
    }
    case 'redeem/status': {
      if (a.status === 'refunded') return s; // only `redeem/refund` can move coins back
      return patchP({
        redemptions: p.redemptions.map((r) =>
          r.id === a.id && r.status !== 'refunded' ? { ...r, status: a.status } : r,
        ),
      });
    }
    case 'redeem/refund': {
      const r = p.redemptions.find((x) => x.id === a.id);
      if (!r || r.status !== 'failed') return s; // refund once, and only after a failure
      return patchP({
        coins: p.coins + r.coins,
        redemptions: p.redemptions.map((x) => (x.id === a.id ? { ...x, status: 'refunded' } : x)),
        history: [
          row(`h-ref-${a.id}`, `Refund: ${r.item} could not be issued`, r.coins),
          ...p.history,
        ],
      });
    }

    case 'step/set':
      return patchO({ step: Math.max(0, Math.min(STEPS.length - 1, a.step)) });
    case 'step/complete':
      return patchO({ done: complete(a.id) });
    case 'account/create':
      return patchO({ accountCreated: true, done: complete('signup') });
    case 'plan/select':
      // No plan change once paid, and none while a payment attempt is in flight.
      if (o.invoicePaid || o.payment?.status === 'processing' || !PLANS.some((x) => x.id === a.id))
        return s;
      return patchO({ plan: a.id });
    case 'payment/start': {
      const plan = PLANS.find((x) => x.id === a.plan);
      if (!plan || o.invoicePaid || o.payment?.status === 'processing') return s;
      // The amount comes from the price list, never from the caller. `plan` follows the attempt.
      return patchO({
        plan: plan.id,
        payment: {
          id: a.id,
          plan: plan.id,
          amount: plan.price,
          last4: a.last4,
          status: 'processing',
        },
      });
    }
    case 'payment/cancel':
      if (o.payment?.id !== a.id || o.payment.status !== 'processing') return s;
      return patchO({ payment: { ...o.payment, status: 'cancelled' } });
    case 'payment/settle': {
      const pay = o.payment;
      if (!pay || pay.id !== a.id || pay.status !== 'processing' || o.invoicePaid) return s; // cancelled or stale: never pays
      if (pay.last4 === DECLINED_LAST4) return patchO({ payment: { ...pay, status: 'declined' } });
      return patchO({
        payment: { ...pay, status: 'paid' },
        invoicePaid: true,
        planActive: true,
        cardLast4: pay.last4,
        paidPlan: pay.plan,
        paidAmount: pay.amount,
        done: complete('plan'),
      });
    }
    case 'sandbox/pass':
      return patchO({ sandboxPassed: true, done: complete('sandbox') });
    case 'live/start':
      // The go-live gate. The step bar lets anyone open this step, so the rule is enforced here.
      return o.accountCreated && o.planActive && o.sandboxPassed && o.live === 'off'
        ? patchO({ live: 'awaiting' })
        : s;
    case 'live/deposit':
      return o.live === 'awaiting' ? patchO({ live: 'live', done: complete('golive') }) : s;
    case 'rules/save':
      return rulesValid(a.rules)
        ? patchO({ rules: { ...a.rules }, rulesSaved: true, done: complete('rules') })
        : s;
    case 'wheel/publish': {
      if (!weightsValid(a.weights) || sameWeights(a.weights, o.wheel.weights)) return s;
      const version = o.wheel.version + 1;
      const ev = expectedPayout(a.weights);
      return patchO({
        wheel: {
          version,
          weights: [...a.weights],
          versions: [
            {
              version,
              state: 'published',
              publishedAt: a.at ?? '2026-11-21',
              note: `Expected payout ${ev.toFixed(1)} coins per spin`,
            },
            ...o.wheel.versions.map((v) => ({ ...v, state: 'archived' as Status })),
          ],
        },
        done: complete('wheel'),
      });
    }
    case 'catalog/price':
      if (!Number.isInteger(a.price) || a.price < 1) return s;
      return patchO({
        catalog: o.catalog.map((i) => (i.id === a.id ? { ...i, priceCoins: a.price } : i)),
      });
    case 'catalog/visible':
      return patchO({
        catalog: o.catalog.map((i) => (i.id === a.id ? { ...i, visible: a.on } : i)),
      });
  }
}
