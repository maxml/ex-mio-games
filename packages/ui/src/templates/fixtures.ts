// Mock data for the template stories and tests. Fake values only: example.com addresses and
// `pk_test_EXAMPLE` style keys. The apps never import this file; they pass real data as props.
import type { ActivityItem } from '../ActivityList';
import type { FunnelStep } from '../Charts';
import type { InvoiceRow } from '../InvoiceTable';
import type { PlanOption } from '../PlanPicker';
import type { ConsoleRole, NavPage } from '../RoleNav';
import type { StoreItem } from '../StoreItemCard';
import type { Step } from '../Stepper';
import type { WeightRow } from '../WeightTable';
import type { WheelSegment } from '../Wheel';
import type { KeyEntry } from '../SetupPanels';
import type { StoreAdminItem } from './Engagement';
import type { RedemptionRow } from './Operations';
import type { Environment, ShellProps } from './OperatorShell';

const roles = (
  admin: NavPage['roles']['admin'],
  staff: NavPage['roles']['staff'],
  support: NavPage['roles']['support'],
  prospect: NavPage['roles']['prospect'] = 'none',
): Record<ConsoleRole, NavPage['roles']['admin']> => ({
  admin,
  staff,
  support,
  prospect,
  platform: 'none',
});

/** The operator page registry, as the web app keeps it (section 2 of the IA spec). */
export const PAGES: NavPage[] = [
  {
    id: 'setup',
    group: 'Get started',
    label: 'Setup',
    href: '/operator/setup',
    roles: roles('write', 'none', 'none', 'write'),
  },
  {
    id: 'rules',
    group: 'Engagement',
    label: 'Rules',
    href: '/operator/engagement/rules',
    roles: roles('write', 'none', 'none'),
  },
  {
    id: 'wheel',
    group: 'Engagement',
    label: 'Wheel',
    href: '/operator/engagement/wheel',
    roles: roles('write', 'none', 'none'),
  },
  {
    id: 'store',
    group: 'Engagement',
    label: 'Store',
    href: '/operator/engagement/store',
    roles: roles('write', 'read', 'none'),
  },
  {
    id: 'redemptions',
    group: 'Operations',
    label: 'Redemptions',
    href: '/operator/operations/redemptions',
    roles: roles('write', 'read', 'none'),
  },
  {
    id: 'insights',
    group: 'Insights',
    label: 'Insights',
    href: '/operator/insights',
    roles: roles('write', 'read', 'read'),
  },
  {
    id: 'team',
    group: 'Team',
    label: 'Team',
    href: '/operator/team',
    roles: roles('write', 'read', 'read'),
    preview: 'Staff list, invites and audit have no operator route yet.',
  },
];

export const SITE_ITEMS = [
  { id: 'home', label: 'Home', href: '#home' },
  { id: 'operator', label: 'Operator', href: '#operator' },
  { id: 'admin', label: 'Admin', href: '#admin' },
  { id: 'widget', label: 'Widget', href: '#widget' },
];

export const STEP_LIST: Omit<Step, 'done'>[] = [
  { id: 'signup', label: 'Account' },
  { id: 'plan', label: 'Plan and payment' },
  { id: 'keys', label: 'Integration keys' },
  { id: 'reward-api', label: 'Reward API' },
  { id: 'sandbox', label: 'Sandbox test' },
  { id: 'golive', label: 'Go live' },
];

/** The first `n` setup steps marked done. */
export const stepsDone = (n: number): Step[] => STEP_LIST.map((s, i) => ({ ...s, done: i < n }));

export const PLANS: PlanOption[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: 99,
    spins: '2,000 spins / month',
    extra: 'Email support',
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 299,
    spins: '10,000 spins / month',
    extra: 'Chat support',
  },
  { id: 'scale', name: 'Scale', price: 799, spins: '50,000 spins / month', extra: 'Named manager' },
];

export const SEGMENTS: WheelSegment[] = ['10', '25', '50', '100', '250', '500'].map((label, i) => ({
  id: `s${i}`,
  label,
}));

export const WHEEL_ROWS: WeightRow[] = [10, 25, 50, 100].map((coins, i) => ({
  id: `r${i}`,
  coins,
}));

export const SANDBOX_KEYS: KeyEntry[] = [
  { id: 'pk', label: 'Publishable key (widget)', value: 'pk_test_EXAMPLE' },
  { id: 'sk', label: 'Secret key (server to server)', value: 'sk_test_EXAMPLE', secret: true },
];

export const LIVE_KEYS: KeyEntry[] = [
  { id: 'pk', label: 'Live publishable key', value: 'pk_live_EXAMPLE' },
  { id: 'sk', label: 'Live secret key', value: 'sk_live_EXAMPLE', secret: true },
];

export const STORE_ITEMS: StoreItem[] = [
  {
    id: 'i1',
    name: '20 free spins',
    description: 'Twenty spins on the featured slot.',
    priceCoins: 500,
    kind: 'free_spins',
  },
  {
    id: 'i2',
    name: '10 EUR cash bonus',
    description: 'Credited to the casino wallet.',
    priceCoins: 2000,
    kind: 'cash_bonus',
    stock: 25,
  },
  {
    id: 'i3',
    name: '5% cashback',
    description: 'On net losses for a day.',
    priceCoins: 1500,
    kind: 'cashback',
  },
];

export const ADMIN_STORE_ITEMS: StoreAdminItem[] = [
  { id: 'i1', name: '20 free spins', priceCoins: 500, bonusEur: 2, visible: true },
  { id: 'i2', name: '10 EUR cash bonus', priceCoins: 2000, bonusEur: 10, visible: true },
  { id: 'i3', name: 'Cashback day', priceCoins: 1500, bonusEur: 5, visible: false },
];

export const REDEMPTIONS: RedemptionRow[] = [
  {
    id: 'r1',
    player: 'player-1001',
    item: '20 free spins',
    priceCoins: 500,
    status: 'pending',
    createdAt: '2026-11-20 10:14',
  },
  {
    id: 'r2',
    player: 'player-1002',
    item: '10 EUR cash bonus',
    priceCoins: 2000,
    status: 'needs_review',
    createdAt: '2026-11-20 11:02',
  },
  {
    id: 'r3',
    player: 'player-1003',
    item: '20 free spins',
    priceCoins: 500,
    status: 'issued',
    createdAt: '2026-11-19 18:40',
  },
  {
    id: 'r4',
    player: 'player-1004',
    item: '5% cashback',
    priceCoins: 1500,
    status: 'failed_refunded',
    createdAt: '2026-11-19 09:31',
  },
];

export const USAGE = [
  { label: 'Spins this month', value: '1,284', delta: 12.4 },
  { label: 'Coins granted', value: '48,200', delta: 3.1 },
  { label: 'Redemptions', value: '96', delta: -4.2 },
];

export const DAILY_SPINS = [40, 52, 38, 61, 70, 55, 48, 66, 72, 59];

export const INVOICES: InvoiceRow[] = [
  { id: 'inv-1', period: '2026-10', amountEur: 299, status: 'paid' },
  { id: 'inv-2', period: '2026-11', amountEur: 299, status: 'open' },
];

export const FUNNEL: FunnelStep[] = [
  { step: 'Deposits', value: 420 },
  { step: 'Spins granted', value: 380 },
  { step: 'Spins played', value: 310 },
  { step: 'Redemptions', value: 96 },
];

export const STAFF = [
  { id: 'u1', email: 'owner@example.com', role: 'Admin', status: 'active' as const },
  { id: 'u2', email: 'agent@example.com', role: 'Staff', status: 'active' as const },
];

export const AUDIT: ActivityItem[] = [
  { id: 'a1', title: 'Wheel version 3 published', subtitle: 'owner@example.com, 2026-11-20 09:55' },
  {
    id: 'a2',
    title: 'Staff invited: agent@example.com',
    subtitle: 'owner@example.com, 2026-11-18 14:02',
  },
];

export const WHEEL_VERSIONS = [
  { id: 'v3', version: 3, status: 'published' as const, at: '2026-11-20' },
  { id: 'v2', version: 2, status: 'archived' as const, at: '2026-11-02' },
];

export const TENANTS = [
  {
    id: 't1',
    name: 'Cherry Row Casino',
    plan: 'Growth',
    status: 'active' as const,
    mrrEur: 299,
  },
  {
    id: 't2',
    name: 'Blue Harbor Games',
    plan: 'Starter',
    status: 'trial' as const,
    mrrEur: 0,
  },
  {
    id: 't3',
    name: 'North Star Bets',
    plan: 'Scale',
    status: 'past_due' as const,
    mrrEur: 799,
  },
];

/** Shell props for a role, for the template stories. */
export const shellFor = (role: ConsoleRole, environment: Environment = 'sandbox'): ShellProps => ({
  role,
  pages: PAGES,
  siteItems: SITE_ITEMS,
  environment,
});

export const HISTORY: ActivityItem[] = [
  { id: 'h1', title: 'Spin reward', subtitle: '2026-11-20 10:14', trailing: '+100' },
  { id: 'h2', title: 'Redeemed 20 free spins', subtitle: '2026-11-19 18:40', trailing: '-500' },
];
