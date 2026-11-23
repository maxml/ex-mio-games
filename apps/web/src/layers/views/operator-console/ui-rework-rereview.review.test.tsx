// Re-review of the UI rework fix round (bf0f3cc..961aedf). Written by the re-reviewer.
// Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-rereview.md.
//
// UIRR-2 (minor, what UIR-1 moved, green guard): UIR-1 made the Resolve flow reachable in the web app, so the
//   resolve preview (spec A-PREV-1 lists "resolve") is now a live action. No test uses it: the UIR-3 test
//   covers Team and the reward API only, and operator-ia.test.tsx A-PREV-1 was not changed. Re-applied by the
//   re-reviewer: in ui/OperationsPages.tsx RedemptionsBody `onResolve`, add
//   `void fetch(\`/api/operator/redemptions/${id}/resolve\`, { method: 'POST' })` -> the whole of
//   src/layers/views stayed green (9 files, 113 tests). Same mutation -> "admin resolves the seeded review
//   row: preview notice, nothing sent" below goes red.
// UIRR-3 (note, what the A-RO-1 deletion moved, green guard): the deleted operator-ia "staff on Redemptions"
//   ran on the default mock state. Its replacement (UIR-2) injects its own row. This pins the default seed
//   too: staff on the default state sees the seeded review row with no Resolve. Mutation: `readOnly={false}`
//   in RedemptionsBody -> red.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MioApiProvider, createIsolatedMockApi, type MioApi } from '@/layers/shared/api';
import { ThemeProvider, type ConsoleRole } from '@/layers/shared/ui';
import { RedemptionsPage, useRoleStore } from '.';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

function mount(ui: ReactElement, role: ConsoleRole, api: MioApi) {
  useRoleStore.setState({ role });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MioApiProvider api={api}>
        <ThemeProvider initialId="mio">{ui}</ThemeProvider>
      </MioApiProvider>
    </QueryClientProvider>,
  );
}

/** Every adapter call except the reads, plus every fetch to /api/. */
function spyAll(api: MioApi) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const calls: string[] = [];
  for (const area of ['player', 'operator', 'admin'] as const) {
    const obj = api[area] as unknown as Record<string, unknown>;
    for (const name of Object.keys(obj)) {
      const fn = obj[name];
      if (typeof fn !== 'function' || name === 'getState' || name === 'getOverview') continue;
      obj[name] = (...args: unknown[]) => {
        calls.push(`${area}.${name}`);
        return (fn as (...a: unknown[]) => unknown).apply(obj, args);
      };
    }
  }
  return () => [
    ...calls,
    ...fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/')),
  ];
}

beforeEach(() => {
  replace.mockClear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UIRR-2 A-PREV-1 for the resolve preview UIR-1 made reachable', () => {
  it('admin resolves the seeded review row: preview notice, nothing sent', async () => {
    const api = createIsolatedMockApi();
    const sent = spyAll(api);
    mount(<RedemptionsPage />, 'admin', api);
    const resolve = await screen.findAllByRole('button', { name: /^Resolve / });
    fireEvent.click(resolve[0]!);
    const submit = await screen.findByRole('button', { name: 'Submit' });
    const form = submit.closest('form')!;
    expect(
      within(form).getByText(/Preview: not connected to a live service yet/),
    ).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Reason'), {
      target: { value: 'casino confirmed the bonus by phone' },
    });
    fireEvent.click(submit);
    await screen.findByText(/Preview, not sent: /);
    await waitFor(() => expect(sent()).toEqual([]));
  });
});

describe('UIRR-3 A-RO-1 staff on Redemptions, on the default mock state', () => {
  it('staff sees the seeded review row and no Resolve; admin on the same state does', async () => {
    mount(<RedemptionsPage />, 'staff', createIsolatedMockApi());
    const table = await screen.findByRole('table', { name: 'Redemptions' });
    expect(within(table).getAllByText('Needs review').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
    cleanup();
    mount(<RedemptionsPage />, 'admin', createIsolatedMockApi());
    expect((await screen.findAllByRole('button', { name: /^Resolve / })).length).toBeGreaterThan(0);
  });
});
