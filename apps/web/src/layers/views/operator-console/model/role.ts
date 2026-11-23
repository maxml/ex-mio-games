'use client';

import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { queryKeys, resolveMioApiMode } from '@/layers/shared/api';
import {
  consoleRole,
  type ConsoleRole,
  type SessionInfo,
} from '@/layers/shared/config/operator-pages';

/**
 * Mock mode only: the role comes from the RoleSwitcher in the shell (default Admin). A test sets it with
 * `useRoleStore.setState({ role })`. In `http` and `hybrid` mode the role comes from `GET /api/session`.
 */
export const useRoleStore = create<{ role: ConsoleRole; setRole: (role: ConsoleRole) => void }>(
  (set) => ({ role: 'admin', setRole: (role) => set({ role }) }),
);

/** `GET /api/session`: the session's roles, or `null` (401) when nobody is signed in. */
async function fetchSession(): Promise<SessionInfo | null> {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`session ${res.status}`);
  return (await res.json()) as SessionInfo;
}

export interface ConsoleRoleState {
  role: ConsoleRole;
  /** False while the session is still being read; no guard decision is made before it is true. */
  ready: boolean;
  /** Present in mock mode only: the switcher's setter. */
  setRole?: (role: ConsoleRole) => void;
}

export function useConsoleRole(): ConsoleRoleState {
  const mock = resolveMioApiMode() === 'mock';
  const stored = useRoleStore((s) => s.role);
  const setRole = useRoleStore((s) => s.setRole);
  const session = useQuery({
    queryKey: [...queryKeys.operator.all, 'session'] as const,
    queryFn: fetchSession,
    enabled: !mock,
    retry: false,
    staleTime: 15_000,
  });
  if (mock) return { role: stored, ready: true, setRole };
  if (session.isPending) return { role: 'prospect', ready: false };
  return { role: consoleRole(session.data ?? null), ready: true };
}
