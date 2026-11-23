// The operator console's page registry: one source of truth (IA spec sections 2 and 3). The nav, the
// route guard, the landing logic and the tests all read OPERATOR_PAGES. Nothing else hard-codes a role
// list. Hrefs have no locale prefix; the view layer adds it for links and next-intl adds it for redirects.
import type { ConsoleRole, NavPage, PageAccess } from '@ex-mio/ui';

export type { ConsoleRole, NavPage, PageAccess };

export type OperatorPageId =
  | 'setup'
  | 'rules'
  | 'wheel'
  | 'store'
  | 'redemptions'
  | 'insights'
  | 'team';

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

export function pageById(id: string): NavPage {
  const page = OPERATOR_PAGES.find((p) => p.id === id);
  if (!page) throw new Error(`Unknown operator page: ${id}`);
  return page;
}

/** What the BFF session says about the signed-in user; `null` when nobody is signed in. */
export interface SessionInfo {
  kind?: string;
  roles: readonly string[];
  acting?: boolean;
}

/**
 * The console role of a session. `operator_admin` is Admin; `operator_staff` is Staff; a platform admin
 * with an acting session is Support; a platform admin without one is Platform (no operator pages); no
 * session, or a player session, is a Prospect (Setup with the Account step only).
 */
export function consoleRole(session: SessionInfo | null): ConsoleRole {
  if (!session) return 'prospect';
  if (session.roles.includes('operator_admin')) return 'admin';
  if (session.roles.includes('operator_staff')) return 'staff';
  if (session.roles.includes('platform_admin')) return session.acting ? 'support' : 'platform';
  return 'prospect';
}

export function accessOf(role: ConsoleRole, pageId: string): PageAccess {
  return pageById(pageId).roles[role];
}

/** The pages a role sees in the nav. */
export function pagesFor(role: ConsoleRole): NavPage[] {
  return OPERATOR_PAGES.filter((p) => p.roles[role] !== 'none');
}

/** Where a role goes first, and where a guard sends a role that may not open a page (locale-free). */
export function landing(role: ConsoleRole, state?: { live?: 'off' | 'awaiting' | 'live' }): string {
  switch (role) {
    case 'admin':
      return state?.live === 'live' ? '/operator/operations/redemptions' : '/operator/setup';
    case 'staff':
      return '/operator/operations/redemptions';
    case 'support':
      return '/operator/insights';
    case 'platform':
      return '/admin';
    case 'prospect':
      return '/operator/setup?step=signup';
  }
}

/** The page id that a landing path belongs to, for the denied redirect. */
export function deniedPath(
  role: ConsoleRole,
  pageId: string,
  state?: Parameters<typeof landing>[1],
) {
  const to = landing(role, state);
  if (role === 'platform') return to;
  return `${to}${to.includes('?') ? '&' : '?'}denied=${pageId}`;
}

/** "Engagement › Rules": the text an access notice names the page by. */
export function pageTitle(pageId: string): string {
  const p = pageById(pageId);
  return p.group === p.label ? p.label : `${p.group} › ${p.label}`;
}
