'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  disconnectWsClient,
  getWsClient,
  isWsConfigured,
  onNotification,
  queryKeys,
  type TokenGetter,
} from '@/layers/shared/api';
import { useConnectionStore } from '@/layers/shared/lib';
import type { NotificationEnvelope } from '@/layers/shared/types';

// FSD `app` layer (ADR-0013 §3.1, §7): the realtime provider, composed inside the
// existing `Providers` so it shares the one QueryClient (it does not create a
// second). It owns the bridge from the singleton socket (`shared/api/ws`) to the
// TanStack Query cache and the Zustand connection store.

/**
 * Map an inbound, already-Zod-validated notification onto the TanStack Query
 * cache (ADR-0014 §7): `invalidateQueries` by default — TanStack
 * Query refetches only the active queries under the key — and `setQueryData` for
 * a high-frequency point update where a refetch round-trip would be wasteful.
 * Reuses the shared query-key factory so a WS write targets the exact key a
 * query reads from. Exported (and pure given a client) for direct testing.
 */
export function applyNotificationToCache(
  queryClient: QueryClient,
  notification: NotificationEnvelope,
): void {
  // High-frequency example: patch the cached value in place instead of refetching.
  if (notification.type === 'health.status') {
    queryClient.setQueryData(queryKeys.health.status(), notification.payload);
    return;
  }
  // Default: invalidate the matching domain root.
  const domain = notification.type.split('.')[0];
  if (domain === 'health') {
    void queryClient.invalidateQueries({ queryKey: queryKeys.health.all });
    return;
  }
  // Fall back to the users domain (the reference query).
  void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
}

export function WSProvider({
  children,
  getToken,
}: {
  children: ReactNode;
  /** Optional handshake token source; defaults to the client's placeholder. */
  getToken?: TokenGetter;
}) {
  // `useQueryClient` returns the stable instance from the parent
  // `QueryClientProvider`, so the effect never re-runs on it and handlers never
  // capture a stale client.
  const queryClient = useQueryClient();
  // Keep the token getter in a ref so a new prop identity doesn't tear down and
  // re-open the socket (handler-in-ref guard against stale closures, ADR-0014 §5.2).
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    // In the browser the WS origin always resolves — to the SAME ORIGIN
    // (`wss://`/`ws://` from `window.location`) when nothing is configured — so
    // realtime is ON even in the domain-agnostic image built with no
    // `NEXT_PUBLIC_API_URL`. This guard only trips on the defensive no-origin
    // path (no window and no configured base), where it marks the store disabled
    // and creates no socket instead of throwing at mount.
    if (!isWsConfigured()) {
      useConnectionStore.getState().setStatus('disabled');
      return;
    }

    // Instantiate the socket only here, on the client — newing it during SSR
    // throws (ADR-0014 §5.2). Read store actions via `getState()` so the handlers
    // never close over a stale snapshot.
    const { setStatus, setError, reset } = useConnectionStore.getState();
    const socket = getWsClient({ getToken: () => getTokenRef.current?.() ?? null });

    const onConnect = () => {
      setStatus('open');
      setError(null);
    };
    const onConnectError = (error: Error) => setError(error.message);
    const onReconnectAttempt = () => setStatus('reconnecting');
    const onReconnectFailed = () => {
      setStatus('closed');
      setError('realtime: reconnection attempts exhausted');
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    // Reconnection lifecycle is emitted by the Manager (`socket.io`), not the socket.
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.io.on('reconnect_failed', onReconnectFailed);

    const offNotification = onNotification(socket, (notification) =>
      applyNotificationToCache(queryClient, notification),
    );

    setStatus('connecting');
    socket.connect();

    return () => {
      offNotification();
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.io.off('reconnect_failed', onReconnectFailed);
      disconnectWsClient();
      reset();
    };
  }, [queryClient]);

  return <>{children}</>;
}
