import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';

// Test helpers shared across the web component suite. `renderWithClient` wraps a
// UI tree in a fresh TanStack Query provider (retries off for deterministic
// errors), mirroring the app-layer `Providers` minus the i18n provider — the
// components under test here read no translations.
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function renderWithClient(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}
