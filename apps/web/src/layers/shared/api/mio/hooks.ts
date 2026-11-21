'use client';

// TanStack Query bindings for the MIO API. Reads poll only while something is in flight (a payment
// being processed, a redemption not yet in a final state), which is the polling the first sellable
// slice uses until live push over the websocket replaces it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../query-keys';
import type { MioApi } from './api';
import { useMioApi } from './context';

const POLL_MS = 800;
const FINAL = new Set(['issued', 'refunded']);

export function usePlayerState() {
  const api = useMioApi();
  return useQuery({
    queryKey: queryKeys.player.state(),
    queryFn: () => api.player.getState(),
    refetchInterval: (q) =>
      q.state.data?.redemptions.some((r) => !FINAL.has(r.status)) ? POLL_MS : false,
  });
}

export function useOperatorState() {
  const api = useMioApi();
  return useQuery({
    queryKey: queryKeys.operator.state(),
    queryFn: () => api.operator.getState(),
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s) return false;
      const inFlight =
        s.payment?.status === 'processing' ||
        s.redemptions.some((r) => r.status === 'pending' || r.status === 'issuing');
      return inFlight ? POLL_MS : false;
    },
  });
}

export function useAdminOverview() {
  const api = useMioApi();
  return useQuery({ queryKey: queryKeys.admin.overview(), queryFn: () => api.admin.getOverview() });
}

/**
 * A write. After it settles every MIO read is refetched, because in the mock (and in the real system)
 * one action moves several screens: an operator price change is a player store change.
 */
export function useMioMutation<Arg, Result = void>(
  run: (api: MioApi, arg: Arg) => Promise<Result>,
) {
  const api = useMioApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: Arg) => run(api, arg),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.player.all }),
        qc.invalidateQueries({ queryKey: queryKeys.operator.all }),
        qc.invalidateQueries({ queryKey: queryKeys.admin.all }),
      ]),
  });
}
