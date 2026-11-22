import type { ReactNode } from 'react';
import { Page, SiteHeader, SkipLink, type NavItem } from '../Page';
import { RoleNav, RoleSwitcher, type ConsoleRole, type NavPage } from '../RoleNav';
import { Badge } from '../StatusPill';
import { Alert } from '../Toast';
import { Text } from '../Typography';

export type PageState = 'ready' | 'loading' | 'error' | 'empty';
export type Environment = 'sandbox' | 'live';

/** What every operator template needs to draw the console around its page. */
export interface ShellProps {
  role: ConsoleRole;
  pages: NavPage[];
  /** Site-level links (the demo chrome: Home, Operator, Admin, Widget). */
  siteItems?: NavItem[];
  environment?: Environment;
  /** Mock mode only: lets a reviewer change the role. */
  onRoleChange?: (role: ConsoleRole) => void;
}

export interface OperatorShellProps extends ShellProps {
  /** Id of the page being shown. */
  current: string;
  title: string;
  intro?: string;
  children: ReactNode;
}

/** The operator console frame: site header, the role's nav, an environment badge and the page. */
export function OperatorShell({
  role,
  pages,
  siteItems = [],
  environment,
  onRoleChange,
  current,
  title,
  intro,
  children,
}: OperatorShellProps) {
  return (
    <div>
      <SkipLink />
      <SiteHeader items={siteItems} current="operator">
        {onRoleChange && <RoleSwitcher value={role} onChange={onRoleChange} />}
      </SiteHeader>
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <RoleNav pages={pages} role={role} current={current} />
        <main id="main" tabIndex={-1} className="min-w-0">
          <Page title={title} intro={intro} className="max-w-none p-0">
            {environment && (
              <p className="mb-4">
                <Badge tone={environment === 'live' ? 'success' : 'warning'} icon>
                  {environment === 'live' ? 'Live environment' : 'Sandbox environment'}
                </Badge>
              </p>
            )}
            {children}
          </Page>
        </main>
      </div>
    </div>
  );
}

/** Body of a template for its loading, error and empty states; `ready` renders the children. */
export function StateBody({
  state = 'ready',
  errorText = 'Something went wrong. Try again.',
  empty,
  children,
}: {
  state?: PageState;
  errorText?: string;
  empty: ReactNode;
  children: ReactNode;
}) {
  if (state === 'loading')
    return (
      <div role="status" aria-busy="true">
        <Text tone="muted">Loading</Text>
      </div>
    );
  if (state === 'error')
    return (
      <Alert tone="danger" live="alert">
        {errorText}
      </Alert>
    );
  if (state === 'empty') return <>{empty}</>;
  return <>{children}</>;
}

/** Shown in place of write controls' page body for a role that can only read. */
export function ReadOnlyNotice() {
  return (
    <Alert tone="info" live="status">
      Read-only: your role can see this page but not change it.
    </Alert>
  );
}

/** Props shared by every operator page template. */
export interface TemplateBase {
  shell: ShellProps;
  state?: PageState;
  errorText?: string;
  /** A read role: write controls are not rendered at all. */
  readOnly?: boolean;
}
