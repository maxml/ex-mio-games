// Hostile review of the operator UI rework (6488273..a531b7b, IA spec section 5). Written by the reviewer.
// Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-review.md.
//
// UIR-1 (major, defect, it.fails): the Redemptions page can never offer "Resolve". The Resolve column draws
//   a button only for a row with status 'needs_review'. The web OperatorRedemptionView.status is the public
//   4-value enum (NEEDS_REVIEW -> 'pending'), the BFF maps `status` and drops `state`, and the mock seed has
//   no review row. So an admin never reaches ResolvePanel in mock or http mode. Goes green when the web
//   state carries "needs review" and the page maps it.
// UIR-2 (major, vacuous test, green now): A-RO-1 "staff on Redemptions" in operator-ia.test.tsx renders a
//   queue with no review row, so it passes with readOnly ignored. This test gives it a review row and a
//   positive control. Mutation (reviewer, re-applied): in ui/OperationsPages.tsx pass `readOnly={false}` to
//   RedemptionsTemplate -> "staff sees the review row but no Resolve" goes red. The same mutation leaves
//   operator-ia.test.tsx green.
// UIR-3 (minor, vacuous test, green now): A-PREV-1 spies on fetch while the page only MOUNTS; the preview
//   ACTIONS (send invite, save the reward API URL) are never used. Mutation (reviewer, re-applied): add
//   `void fetch('/api/operator/staff', { method: 'POST' })` to TeamBody's onInvite -> "Team: Send invite"
//   goes red; operator-ia.test.tsx stays green. The adapter is spied too, so a preview that calls the
//   API object instead of fetch is caught as well.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MioApiProvider, createIsolatedMockApi, type MioApi } from '@/layers/shared/api';
import { ThemeProvider, type ConsoleRole } from '@/layers/shared/ui';
import { RedemptionsPage, SetupPage, TeamPage, useRoleStore } from '.';

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

/** The isolated mock, with one redemption that waits for an operator review added to the queue. */
function withReviewRow(): MioApi {
  const api = createIsolatedMockApi();
  const getState = api.operator.getState.bind(api.operator);
  api.operator.getState = async () => {
    const s = await getState();
    const review = {
      id: 'r-review',
      player: 'player-2001',
      item: '10 EUR cash bonus',
      coins: 500,
      status: 'needs_review',
      at: '2026-11-21 10:00',
    } as unknown as (typeof s.redemptions)[number];
    return { ...s, redemptions: [review, ...s.redemptions] };
  };
  return api;
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

describe('UIR-1 an admin can open a review from the Redemptions page (spec section 2, row 5)', () => {
  // DEFECT: no row of the web operator state can be 'needs_review' (contract enum, BFF map, mock seed).
  it('the default console state offers at least one Resolve action to an admin', async () => {
    mount(<RedemptionsPage />, 'admin', createIsolatedMockApi());
    await screen.findByRole('table', { name: 'Redemptions' });
    expect(screen.getAllByRole('button', { name: /^Resolve / }).length).toBeGreaterThan(0);
  });
});

describe('UIR-2 A-RO-1 with a review row present (the original test has none)', () => {
  it('admin: the review row has a Resolve button and it opens the panel (positive control)', async () => {
    mount(<RedemptionsPage />, 'admin', withReviewRow());
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve r-review' }));
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('staff sees the review row but no Resolve', async () => {
    mount(<RedemptionsPage />, 'staff', withReviewRow());
    const table = await screen.findByRole('table', { name: 'Redemptions' });
    await within(table).findByText('player-2001');
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });
});

describe('UIR-3 A-PREV-1: using a preview action sends nothing (the original only mounts)', () => {
  /** Every adapter call except the state read, plus every fetch to /api/. */
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

  it('Team: Send invite', async () => {
    const api = createIsolatedMockApi();
    const sent = spyAll(api);
    mount(<TeamPage />, 'admin', api);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'new.staff@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByText(/Invited new\.staff@example\.com/);
    expect(sent()).toEqual([]);
  });

  it('Setup: save the reward API URL', async () => {
    const api = createIsolatedMockApi();
    const sent = spyAll(api);
    mount(<SetupPage step="reward-api" />, 'admin', api);
    fireEvent.change(await screen.findByLabelText('Reward endpoint URL'), {
      target: { value: 'https://casino.example/reward' },
    });
    const form = screen.getByLabelText('Reward endpoint URL').closest('form')!;
    fireEvent.submit(form);
    await screen.findByText(/preview, not sent/);
    await waitFor(() => expect(sent()).toEqual([]));
  });
});
