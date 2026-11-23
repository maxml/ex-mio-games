'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { MioApiError, useOperatorState } from '@/layers/shared/api';
import { useRouter } from 'next/navigation';
import {
  OPERATOR_PAGES,
  accessOf,
  deniedPath,
  pageTitle,
  type PageAccess,
} from '@/layers/shared/config/operator-pages';
import {
  AccessNotice,
  ROLE_LABEL,
  Text,
  type ShellProps,
  type TemplateBase,
} from '@/layers/shared/ui';
import { useConsoleRole } from './role';

/** Locale prefix for nav links (`/en`). The operator layout sets it; tests leave it empty. */
const BaseContext = createContext('');

export function ConsoleBaseProvider({ base, children }: { base: string; children: ReactNode }) {
  return <BaseContext.Provider value={base}>{children}</BaseContext.Provider>;
}

export const useConsoleBase = () => useContext(BaseContext);

const SUPPORT_TEXT = "Support access cannot read this tenant's engagement data.";

/** Everything an operator template needs around its page: shell props, load state, the loaded state. */
export function useOperatorPage(pageId: string, denied?: string) {
  const q = useOperatorState();
  const { role, setRole } = useConsoleRole();
  const base = useConsoleBase();
  // A prospect has no session, so a refusal is expected and is not worth a notice.
  const refused =
    q.error instanceof MioApiError && q.error.code === 'forbidden' && role !== 'prospect';
  const deniedId =
    denied && OPERATOR_PAGES.some((p) => p.id === denied) ? denied : refused ? pageId : undefined;
  const shell: ShellProps = {
    role,
    pages: OPERATOR_PAGES.map((p) => ({ ...p, href: `${base}${p.href}` })),
    embedded: true,
    environment: q.data?.live === 'live' ? 'live' : 'sandbox',
    onRoleChange: setRole,
    notice: deniedId ? (
      <AccessNotice role={ROLE_LABEL[role]} page={pageTitle(deniedId)} />
    ) : undefined,
  };
  const state: TemplateBase['state'] = q.isPending ? 'loading' : q.isError ? 'error' : undefined;
  return {
    s: q.data,
    shell,
    state,
    errorText: refused && role === 'support' ? SUPPORT_TEXT : 'The console could not be loaded.',
    role,
  };
}

/** Sends the browser to `to` (locale-free path). Mounted only when a guard denies, so the router is only needed then. */
function Redirect({ to }: { to: string }) {
  const router = useRouter();
  const base = useConsoleBase();
  useEffect(() => {
    router.replace(`${base}${to}`);
  }, [router, base, to]);
  return (
    <Text tone="muted" role="status">
      Redirecting
    </Text>
  );
}

/**
 * Wraps one operator page. A role with no access is sent to its landing page with `?denied=<page>`
 * (a platform admin goes to /admin). A role with read access gets `readOnly`, so the template draws no
 * write control at all.
 */
export function RequireAccess({
  pageId,
  children,
}: {
  pageId: string;
  children: (ctx: { readOnly: boolean; access: PageAccess }) => ReactNode;
}) {
  const { role, ready } = useConsoleRole();
  if (!ready)
    return (
      <Text tone="muted" role="status">
        Loading
      </Text>
    );
  const access = accessOf(role, pageId);
  if (access === 'none') return <Redirect to={deniedPath(role, pageId)} />;
  return <>{children({ readOnly: access === 'read', access })}</>;
}
