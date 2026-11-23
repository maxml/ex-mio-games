import { AccessNotice, Alert, ROLE_LABEL, type ConsoleRole, type ShellProps } from '@ex-mio/ui';
import { OPERATOR_PAGES, pageTitle } from '../../config/operator-pages';
import { useApp } from '../../state/store';

/** Nav links are hash routes in the prototype. */
const PAGES = OPERATOR_PAGES.map((p) => ({ ...p, href: `#${p.href}` }));

/**
 * What every operator template needs around its page: the role's nav (from the registry), the
 * environment badge, an access notice after a guard redirect, and the acting-session banner for Support.
 * The role comes from the app store, so one switcher in the header drives every page.
 */
export function useOperatorShell(denied?: string): { shell: ShellProps; role: ConsoleRole } {
  const session = useApp((s) => s.session);
  const live = useApp((s) => s.operator.live);
  // Only operator roles reach an operator screen (the guard in the router sends the rest away).
  const role = session.role as ConsoleRole;
  const notice =
    session.actingReason || denied ? (
      <>
        {session.actingReason && (
          <Alert tone="warning" live="status">
            Acting session as Support: you are reading a tenant for a ticket. Reason:{' '}
            {session.actingReason}. Every action is audited and the session ends after 15 minutes.
          </Alert>
        )}
        {denied && <AccessNotice role={ROLE_LABEL[role]} page={pageTitle(denied)} />}
      </>
    ) : undefined;
  return {
    role,
    shell: {
      role,
      pages: PAGES,
      embedded: true,
      environment: live === 'live' ? 'live' : 'sandbox',
      notice,
    },
  };
}
