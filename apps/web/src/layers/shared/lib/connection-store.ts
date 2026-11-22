import { create } from 'zustand';

// Realtime connection/presence state lives in Zustand, NOT the TanStack Query
// cache (ADR-0014 §7: connection status is ephemeral UI state, not
// server state). The app-layer `WSProvider` writes the socket lifecycle into
// this store; any layer can read `status` for a connection badge via a narrow
// selector (so it sits in `shared`, reachable by widgets/features below `app`).

// `disabled` means no realtime origin could be resolved, so no socket is ever
// created — distinct from `closed` (configured but not currently connected).
// In the browser the WS origin always resolves (same origin by default), so
// this is a defensive no-window path; it still lets a connection badge show
// "realtime off" instead of a perpetual "disconnected".
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'disabled';

interface ConnectionState {
  status: ConnectionStatus;
  /** Last transport/handshake error message, surfaced for diagnostics. */
  lastError: string | null;
  setStatus: (status: ConnectionStatus) => void;
  setError: (message: string | null) => void;
  reset: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'closed',
  lastError: null,
  setStatus: (status) => set({ status }),
  setError: (lastError) => set({ lastError }),
  reset: () => set({ status: 'closed', lastError: null }),
}));

// Narrow selector for UI badges: re-renders the consumer only when the status
// string changes, not on every store update.
export const useConnectionStatus = (): ConnectionStatus =>
  useConnectionStore((state) => state.status);
