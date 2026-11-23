// The prototype's copy of the operator page registry. The web app keeps the original in
// apps/web/src/layers/shared/config/operator-pages.ts (IA spec sections 2 and 3). The prototype is
// outside the pnpm workspace and cannot import from apps/web, so the registry is copied as DATA: the
// same ids, groups, hrefs and role access. The two copies must stay equal (A-PROTO-3).
import type { ConsoleRole, NavPage, PageAccess } from '@ex-mio/ui';

export type { ConsoleRole, NavPage, PageAccess };

/** The five prototype roles: the four backend identities (admin, staff, support = acting platform admin, platform admin) plus the player. */
export type ProtoRole = Exclude<ConsoleRole, 'prospect'> | 'player';

export const PROTO_ROLES: ProtoRole[] = ['admin', 'staff', 'support', 'platform', 'player'];

export const ROLE_OPTION_LABEL: Record<ProtoRole, string> = {
  admin: 'Admin (operator_admin)',
  staff: 'Staff (operator_staff, read-only)',
  support: 'Support (acting session)',
  platform: 'Platform admin',
  player: 'Player',
};

const access = (
  admin: PageAccess,
  staff: PageAccess,
  support: PageAccess,
  prospect: PageAccess = 'none',
): NavPage['roles'] => ({ admin, staff, support, prospect, platform: 'none' });

export const OPERATOR_PAGES: NavPage[] = [
  {
    id: 'setup',
    group: 'Get started',
    label: 'Setup',
    href: '/operator/setup',
    roles: access('write', 'none', 'none', 'write'),
  },
  {
    id: 'rules',
    group: 'Engagement',
    label: 'Rules',
    href: '/operator/engagement/rules',
    roles: access('write', 'none', 'none'),
  },
  {
    id: 'wheel',
    group: 'Engagement',
    label: 'Wheel',
    href: '/operator/engagement/wheel',
    roles: access('write', 'none', 'none'),
  },
  {
    id: 'store',
    group: 'Engagement',
    label: 'Store',
    href: '/operator/engagement/store',
    roles: access('write', 'read', 'none'),
  },
  {
    id: 'redemptions',
    group: 'Operations',
    label: 'Redemptions',
    href: '/operator/operations/redemptions',
    roles: access('write', 'read', 'none'),
  },
  {
    id: 'insights',
    group: 'Insights',
    label: 'Insights',
    href: '/operator/insights',
    roles: access('write', 'read', 'read'),
  },
  {
    id: 'team',
    group: 'Team',
    label: 'Team',
    href: '/operator/team',
    roles: access('write', 'read', 'read'),
    preview: 'Staff list, invite and audit have no operator route yet.',
  },
];

export function pageById(id: string): NavPage | undefined {
  return OPERATOR_PAGES.find((p) => p.id === id);
}

export function accessOf(role: ProtoRole, pageId: string): PageAccess {
  const page = pageById(pageId);
  if (!page || role === 'player') return 'none';
  return page.roles[role];
}

/** Where a role goes first, and where a guard sends a role that may not open a page (hash path). */
export function landing(role: ProtoRole, state?: { live?: 'off' | 'awaiting' | 'live' }): string {
  switch (role) {
    case 'admin':
      return state?.live === 'live' ? '/operator/operations/redemptions' : '/operator/setup';
    case 'staff':
      return '/operator/operations/redemptions';
    case 'support':
      return '/operator/insights';
    case 'platform':
      return '/admin';
    case 'player':
      return '/player';
  }
}

/** "Engagement › Rules": the text an access notice names the page by. */
export function pageTitle(pageId: string): string {
  if (pageId === 'admin') return 'Platform admin';
  if (pageId === 'player') return 'Player widget';
  const p = pageById(pageId);
  if (!p) return pageId;
  return p.group === p.label ? p.label : `${p.group} › ${p.label}`;
}
