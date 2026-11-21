import { create } from 'zustand';

// Client/UI state lives in Zustand, not in the TanStack Query cache (ADR-0005 §4.2,
// §5.2: ephemeral UI — modals, filters, theme, connection status). This small
// store is the reference pattern: a typed state shape + actions, consumed from
// `'use client'` components via narrow selectors.

export type Theme = 'dark' | 'light';

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  toggleTheme: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: 'dark',
  sidebarOpen: false,
  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}));

// Typed selector example: subscribing to a single field re-renders the consumer
// only when that field changes, instead of on every store update. `Theme` is
// inferred end-to-end — no annotation needed at the call site.
export const useTheme = (): Theme => useUiStore((state) => state.theme);
