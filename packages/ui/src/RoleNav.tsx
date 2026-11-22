import { Badge } from './StatusPill';
import { Select } from './Input';
import { cn } from './cn';

/** Console roles (UI names). `platform` and `prospect` never see operator pages except Setup for prospect. */
export type ConsoleRole = 'admin' | 'staff' | 'support' | 'prospect' | 'platform';
export type PageAccess = 'write' | 'read' | 'none';

export const ROLE_LABEL: Record<ConsoleRole, string> = {
  admin: 'Admin',
  staff: 'Staff',
  support: 'Support',
  prospect: 'Prospect',
  platform: 'Platform admin',
};

/** One operator page. The apps keep the single registry of these; the nav only reads it. */
export interface NavPage {
  id: string;
  group: string;
  label: string;
  href: string;
  roles: Record<ConsoleRole, PageAccess>;
  /** Set when the page is backed by no live service yet: the nav shows a "Preview" badge. */
  preview?: string;
}

export const NAV_GROUPS = ['Get started', 'Engagement', 'Operations', 'Insights', 'Team'] as const;

export interface RoleNavProps {
  pages: NavPage[];
  role: ConsoleRole;
  /** Id of the page being shown. */
  current?: string;
  className?: string;
}

/**
 * Side navigation for the operator console. Shows only the pages the role can open (access not
 * `none`), in fixed group order, hides a group that ends up empty, and badges read-only and preview
 * pages with words.
 */
export function RoleNav({ pages, role, current, className }: RoleNavProps) {
  const groups = [...new Set([...NAV_GROUPS, ...pages.map((p) => p.group)])]
    .map((g) => ({
      group: g,
      items: pages.filter((p) => p.group === g && p.roles[role] !== 'none'),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <nav aria-label="Operator pages" className={className}>
      <ul className="grid gap-4">
        {groups.map(({ group, items }) => (
          <li key={group}>
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {group}
            </p>
            <ul className="grid gap-0.5">
              {items.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2">
                  <a
                    href={p.href}
                    aria-current={p.id === current ? 'page' : undefined}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-semibold',
                      p.id === current
                        ? 'bg-primary text-primary-fg'
                        : 'text-fg hover:bg-surface-2',
                    )}
                  >
                    {p.label}
                  </a>
                  {p.roles[role] === 'read' && <Badge>Read-only</Badge>}
                  {p.preview && <Badge tone="info">Preview</Badge>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface RoleSwitcherProps {
  value: ConsoleRole;
  onChange: (role: ConsoleRole) => void;
  /** Roles offered. Defaults to the three operator-console roles. */
  roles?: ConsoleRole[];
}

/** Mock-mode role picker for the site header (shown only when the adapter is `mock`). */
export function RoleSwitcher({
  value,
  onChange,
  roles = ['admin', 'staff', 'support'],
}: RoleSwitcherProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-fg-muted">Role</span>
      <Select size="sm" value={value} onChange={(e) => onChange(e.target.value as ConsoleRole)}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </Select>
    </label>
  );
}
