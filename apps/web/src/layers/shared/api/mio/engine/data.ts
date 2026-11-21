// All data in the prototype is static and invented. Nothing here comes from a real system.
import type { StoreItemView as StoreItem } from '../../../types';

/** Every status the mock engine can emit (a subset of what the StatusPill knows). */
export type Status =
  | 'pending'
  | 'issuing'
  | 'issued'
  | 'failed_refunded'
  | 'trial'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'draft'
  | 'published'
  | 'archived';

export interface WheelReward {
  id: string;
  label: string;
  coins: number;
  /** Relative weight; probability = weight / sum(weights). */
  weight: number;
}

export const WHEEL_REWARDS: WheelReward[] = [
  { id: 'r1', label: '10', coins: 10, weight: 30 },
  { id: 'r2', label: '25', coins: 25, weight: 24 },
  { id: 'r3', label: '50', coins: 50, weight: 18 },
  { id: 'r4', label: '100', coins: 100, weight: 12 },
  { id: 'r5', label: '250', coins: 250, weight: 8 },
  { id: 'r6', label: '500', coins: 500, weight: 5 },
  { id: 'r7', label: '1000', coins: 1000, weight: 2.5 },
  { id: 'r8', label: '5', coins: 5, weight: 0.5 },
];

/** Expected coins per spin for a weight vector (same order as WHEEL_REWARDS). */
export function expectedPayout(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  return total > 0
    ? WHEEL_REWARDS.reduce((s, r, i) => s + (r.coins * (weights[i] ?? 0)) / total, 0)
    : 0;
}

export interface WheelVersion {
  version: number;
  state: Status;
  publishedAt: string;
  note: string;
}

export const WHEEL_VERSIONS: WheelVersion[] = [
  // The note is derived from the table above, never typed, so it cannot drift from the odds.
  {
    version: 3,
    state: 'published',
    publishedAt: '2026-11-18',
    note: `Current: expected payout ${expectedPayout(WHEEL_REWARDS.map((r) => r.weight)).toFixed(1)} coins per spin`,
  },
  {
    version: 2,
    state: 'archived' as Status,
    publishedAt: '2026-11-04',
    note: 'Jackpot weight 4 (too generous)',
  },
  { version: 1, state: 'archived' as Status, publishedAt: '2026-10-20', note: 'Initial table' },
];

export const STORE_ITEMS: StoreItem[] = [
  {
    id: 's1',
    name: '20 free spins',
    description: 'On a featured slot, wager free.',
    priceCoins: 300,
    kind: 'free_spins',
  },
  {
    id: 's2',
    name: '5 EUR bonus',
    description: 'Credited to the casino bonus wallet.',
    priceCoins: 500,
    kind: 'cash_bonus',
  },
  {
    id: 's3',
    name: '50 free spins',
    description: 'On a featured slot, wager free.',
    priceCoins: 1200,
    kind: 'free_spins',
    stock: 40,
  },
  {
    id: 's4',
    name: '10% cashback',
    description: 'Next 24 hours of net losses.',
    priceCoins: 2000,
    kind: 'cashback',
  },
  {
    id: 's5',
    name: '50 EUR bonus',
    description: 'Credited to the casino bonus wallet.',
    priceCoins: 4500,
    kind: 'cash_bonus',
    stock: 0,
  },
  {
    id: 's6',
    name: 'VIP lounge day',
    description: 'Priority support for 24 hours.',
    priceCoins: 800,
    kind: 'merch',
    stock: 12,
  },
];

export interface Redemption {
  id: string;
  player: string;
  item: string;
  coins: number;
  status: Status;
  at: string;
  note?: string;
}

export const REDEMPTIONS: Redemption[] = [
  {
    id: 'rd-1042',
    player: 'p_7f3a',
    item: '20 free spins',
    coins: 300,
    status: 'issued',
    at: '2026-11-21 14:02',
  },
  {
    id: 'rd-1041',
    player: 'p_c91d',
    item: '5 EUR bonus',
    coins: 500,
    status: 'pending',
    at: '2026-11-21 13:58',
  },
  {
    id: 'rd-1040',
    player: 'p_22be',
    item: '50 free spins',
    coins: 1200,
    status: 'failed_refunded',
    at: '2026-11-21 13:40',
    note: 'Casino returned 503; coins refunded',
  },
  {
    id: 'rd-1039',
    player: 'p_22be',
    item: '50 free spins',
    coins: 1200,
    status: 'failed_refunded',
    at: '2026-11-21 13:41',
    note: 'Refund of rd-1040',
  },
  {
    id: 'rd-1038',
    player: 'p_a4e0',
    item: '10% cashback',
    coins: 2000,
    status: 'issued',
    at: '2026-11-21 12:15',
  },
  {
    id: 'rd-1037',
    player: 'p_90cc',
    item: 'VIP lounge day',
    coins: 800,
    status: 'issuing',
    at: '2026-11-21 12:03',
  },
];

export const PLAYER_HISTORY = [
  { id: 'h1', at: 'Today 14:02', what: 'Redeemed 20 free spins', delta: -300 },
  { id: 'h2', at: 'Today 13:55', what: 'Spin: landed on 250', delta: 250 },
  { id: 'h3', at: 'Today 13:50', what: 'Deposit 40 EUR earned 2 spins', delta: 0 },
  { id: 'h4', at: 'Yesterday', what: 'Spin: landed on 50', delta: 50 },
  { id: 'h5', at: 'Yesterday', what: 'Spin: landed on 10', delta: 10 },
];

export const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 199,
    spins: '20,000 spins / month',
    extra: '1 casino, sandbox, email support',
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 799,
    spins: '150,000 spins / month',
    extra: '3 casinos, custom theme, webhooks log',
  },
  {
    id: 'scale',
    name: 'Scale',
    price: 2499,
    spins: '1,000,000 spins / month',
    extra: 'Unlimited casinos, SLA, single sign-on',
  },
];

export const SANDBOX_STEPS = [
  { id: 'ping', label: 'Casino reachable', detail: 'POST /webhooks/mio answered 200 in 84 ms' },
  {
    id: 'sig',
    label: 'Signature verified',
    detail: 'HMAC-SHA256 header matched the webhook secret',
  },
  {
    id: 'dep',
    label: 'Deposit event accepted',
    detail: 'deposit.confirmed, 40 EUR, 2 spins granted',
  },
  { id: 'dup', label: 'Duplicate event ignored', detail: 'Same event id replayed: no extra spins' },
  {
    id: 'rew',
    label: 'Reward issued back',
    detail: 'bonus.grant returned 200; redemption marked issued',
  },
];

export const TENANTS = [
  {
    id: 't1',
    name: 'Lucky Star Casino',
    plan: 'Growth',
    status: 'active' as Status,
    mrr: 799,
    spins: 98200,
    depositors: 4120,
    signup: '2026-09-02',
  },
  {
    id: 't2',
    name: 'Northbet',
    plan: 'Scale',
    status: 'active' as Status,
    mrr: 2499,
    spins: 612400,
    depositors: 21800,
    signup: '2026-08-11',
  },
  {
    id: 't3',
    name: 'Cherry Row',
    plan: 'Starter',
    status: 'trial' as Status,
    mrr: 0,
    spins: 3100,
    depositors: 190,
    signup: '2026-11-14',
  },
  {
    id: 't4',
    name: 'Golden Pier',
    plan: 'Starter',
    status: 'past_due' as Status,
    mrr: 199,
    spins: 15800,
    depositors: 760,
    signup: '2026-10-01',
  },
  {
    id: 't5',
    name: 'Aurora Spins',
    plan: 'Growth',
    status: 'suspended' as Status,
    mrr: 0,
    spins: 0,
    depositors: 0,
    signup: '2026-07-19',
  },
];

export const FUNNEL = [
  { step: 'Signups', value: 240 },
  { step: 'Plan chosen', value: 150 },
  { step: 'Keys created', value: 118 },
  { step: 'Sandbox test passed', value: 74 },
  { step: 'First live deposit', value: 41 },
  { step: 'Paid invoice', value: 29 },
];

export const USAGE_DAYS = [31, 36, 33, 41, 44, 39, 47, 52, 49, 55, 58, 54, 61, 66];
