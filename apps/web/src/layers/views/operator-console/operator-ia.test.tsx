// IA acceptance (spec section 5, T2): role-aware nav, guards, read-only pages, landing, split pages, previews.
// Expected values are literal tables in this file, never read back from OPERATOR_PAGES.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MioApiProvider, createIsolatedMockApi, type MioApi } from '@/layers/shared/api';
import { OPERATOR_PAGES, consoleRole, landing } from '@/layers/shared/config/operator-pages';
import { OperatorShell, ThemeProvider, type ConsoleRole } from '@/layers/shared/ui';
import {
  InsightsPage,
  OperatorIndex,
  RedemptionsPage,
  RulesPage,
  SetupPage,
  StorePage,
  TeamPage,
  WheelPage,
  useRoleStore,
} from '.';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

function mount(
  ui: ReactElement,
  role: ConsoleRole = 'admin',
  api: MioApi = createIsolatedMockApi(),
) {
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
  return { api };
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

const PAGES: Record<string, () => ReactElement> = {
  setup: () => <SetupPage />,
  rules: () => <RulesPage />,
  wheel: () => <WheelPage />,
  store: () => <StorePage />,
  redemptions: () => <RedemptionsPage />,
  insights: () => <InsightsPage />,
  team: () => <TeamPage />,
};

// A-NAV-1: what each role sees, as a literal table.
const NAV: Record<'admin' | 'staff' | 'support' | 'prospect', string[]> = {
  admin: ['Setup', 'Rules', 'Wheel', 'Store', 'Redemptions', 'Insights', 'Team'],
  staff: ['Store', 'Redemptions', 'Insights', 'Team'],
  support: ['Insights', 'Team'],
  prospect: ['Setup'],
};

describe('consoleRole and landing', () => {
  it('maps the session to a console role', () => {
    expect(consoleRole({ roles: ['operator_admin'] })).toBe('admin');
    expect(consoleRole({ roles: ['operator_staff'] })).toBe('staff');
    expect(consoleRole({ roles: ['platform_admin'], acting: true })).toBe('support');
    expect(consoleRole({ roles: ['platform_admin'], acting: false })).toBe('platform');
    expect(consoleRole({ roles: ['player'] })).toBe('prospect');
    expect(consoleRole(null)).toBe('prospect');
  });

  // A-LAND-1
  it('lands each role on its first page', () => {
    expect(landing('admin', { live: 'off' })).toBe('/operator/setup');
    expect(landing('admin', { live: 'awaiting' })).toBe('/operator/setup');
    expect(landing('admin', { live: 'live' })).toBe('/operator/operations/redemptions');
    expect(landing('staff')).toBe('/operator/operations/redemptions');
    expect(landing('support')).toBe('/operator/insights');
    expect(landing('prospect')).toBe('/operator/setup?step=signup');
    expect(landing('platform')).toBe('/admin');
  });
});

describe('A-NAV-1 role nav', () => {
  // Mutation: add `staff: 'read'` to Rules in OPERATOR_PAGES and the staff row turns red.
  for (const role of ['admin', 'staff', 'support', 'prospect'] as const) {
    it(`${role} sees exactly its pages`, () => {
      render(
        <OperatorShell role={role} pages={OPERATOR_PAGES} current="setup" title="t">
          x
        </OperatorShell>,
      );
      const nav = screen.getByRole('navigation', { name: 'Operator pages' });
      const names = within(nav)
        .getAllByRole('link')
        .map((a) => (a.textContent ?? '').replace(/(Read-only|Preview)$/, '').trim());
      expect(names).toEqual(NAV[role]);
    });
  }

  it('a platform admin sees no operator page', () => {
    render(
      <OperatorShell role="platform" pages={OPERATOR_PAGES} current="setup" title="t">
        x
      </OperatorShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Operator pages' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('a real page draws the nav of the stored role, with read-only and preview words', async () => {
    mount(<InsightsPage />, 'staff');
    const nav = await screen.findByRole('navigation', { name: 'Operator pages' });
    expect(within(nav).queryByRole('link', { name: /Rules/ })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Store/ }).closest('li')).toHaveTextContent(
      'Read-only',
    );
    expect(within(nav).getByRole('link', { name: /Team/ }).closest('li')).toHaveTextContent(
      'Preview',
    );
  });
});

describe('A-GUARD-1 and A-NAV-2: a page a role may not open redirects to its landing', () => {
  const DENIED: Array<[ConsoleRole, string, string]> = [
    ['staff', 'setup', '/operator/operations/redemptions?denied=setup'],
    ['staff', 'rules', '/operator/operations/redemptions?denied=rules'],
    ['staff', 'wheel', '/operator/operations/redemptions?denied=wheel'],
    ['support', 'setup', '/operator/insights?denied=setup'],
    ['support', 'rules', '/operator/insights?denied=rules'],
    ['support', 'wheel', '/operator/insights?denied=wheel'],
    ['support', 'store', '/operator/insights?denied=store'],
    ['support', 'redemptions', '/operator/insights?denied=redemptions'],
    ['prospect', 'rules', '/operator/setup?step=signup&denied=rules'],
    ['prospect', 'wheel', '/operator/setup?step=signup&denied=wheel'],
    ['prospect', 'store', '/operator/setup?step=signup&denied=store'],
    ['prospect', 'redemptions', '/operator/setup?step=signup&denied=redemptions'],
    ['prospect', 'insights', '/operator/setup?step=signup&denied=insights'],
    ['prospect', 'team', '/operator/setup?step=signup&denied=team'],
    ...Object.keys(PAGES).map((id): [ConsoleRole, string, string] => ['platform', id, '/admin']),
  ];
  // Mutation: drop RequireAccess from one page and its row turns red.
  it.each(DENIED)('%s on %s goes to %s', async (role, id, to) => {
    mount(PAGES[id]!(), role);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(to));
  });

  it('the landing page names the role and the page', async () => {
    mount(<RedemptionsPage denied="rules" />, 'staff');
    expect(
      await screen.findByText(
        'Your role (Staff) cannot open Engagement › Rules. Ask an operator admin.',
      ),
    ).toBeInTheDocument();
  });

  it('support sees the notice on Insights', async () => {
    mount(<InsightsPage denied="store" />, 'support');
    expect(
      await screen.findByText(
        'Your role (Support) cannot open Engagement › Store. Ask an operator admin.',
      ),
    ).toBeInTheDocument();
  });

  it('nobody is redirected from a page the role may open', async () => {
    mount(<StorePage />, 'staff');
    await screen.findByRole('heading', { name: 'Bonus store' });
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('A-RO-1 read-only pages draw no write control', () => {
  it('staff on Store', async () => {
    mount(<StorePage />, 'staff');
    await screen.findByText('Catalog');
    expect(screen.queryByRole('button', { name: /add item|add your first item/i })).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('admin on Store has them', async () => {
    mount(<StorePage />, 'admin');
    await screen.findByText('Catalog');
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });

  // "staff on Redemptions" lives in ui-rework.review.test.tsx (UIR-2): it has a review row and an admin
  // positive control, which this queue-without-a-review-row version lacked.

  it('support on Insights has no Pay button', async () => {
    mount(<InsightsPage />, 'support');
    await screen.findByRole('heading', { name: 'Invoices' });
    expect(screen.queryByRole('button', { name: /^pay/i })).toBeNull();
  });

  it('staff on Team cannot invite', async () => {
    mount(<TeamPage />, 'staff');
    await screen.findByRole('heading', { name: 'Staff' });
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull();
  });
});

describe('A-SPLIT-1 no page mixes jobs', () => {
  const FOREIGN: Record<string, RegExp> = {
    setup: /Redemptions|Spin rule|Catalog|Invoices|Wheel reward|Staff/,
    rules: /Choose a plan|Catalog|Invoices|Redemptions list/,
    wheel: /Choose a plan|Spin rule|Catalog|Invoices/,
    store: /Choose a plan|Spin rule|Invoices|Wheel/,
    redemptions: /Choose a plan|Spin rule|Catalog|Invoices|Wheel/,
    insights: /Choose a plan|Spin rule|Catalog|Redemptions|Wheel/,
    team: /Choose a plan|Spin rule|Catalog|Invoices|Redemptions|Wheel/,
  };
  it.each(Object.keys(PAGES))('%s', async (id) => {
    mount(PAGES[id]!(), 'admin');
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByText('Loading')).toBeNull());
    const headings = screen.getAllByRole('heading').map((h) => h.textContent ?? '');
    expect(headings.filter((h) => FOREIGN[id]!.test(h))).toEqual([]);
  });
});

describe('A-PREV-1 previews are labelled and send nothing', () => {
  const PREVIEW = /Preview: not connected to a live service yet/;

  it.each(['keys', 'reward-api', 'sandbox', 'golive'])('setup step %s', async (step) => {
    const spy = vi.spyOn(globalThis, 'fetch');
    mount(<SetupPage step={step} />);
    expect((await screen.findAllByText(PREVIEW)).length).toBeGreaterThan(0);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('/api/'))).toEqual([]);
  });

  it('Team', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    mount(<TeamPage />);
    expect((await screen.findAllByText(PREVIEW)).length).toBeGreaterThan(0);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('/api/'))).toEqual([]);
  });

  it('the funnel on Insights', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    mount(<InsightsPage />);
    await screen.findByText('Player funnel');
    expect(screen.getAllByText(PREVIEW).length).toBeGreaterThan(0);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('/api/'))).toEqual([]);
  });
});

describe('the pages work', () => {
  it('Setup shows "n of 6 done" and only the open step', async () => {
    mount(<SetupPage />);
    expect(await screen.findByText('0 of 6 done')).toBeInTheDocument();
    expect(screen.queryByText('Choose a plan')).toBeNull();
  });

  it('Setup opens the step named in ?step', async () => {
    mount(<SetupPage step="plan" />);
    expect(await screen.findByText('Choose a plan')).toBeInTheDocument();
  });

  it('Setup counts only what the server says is done', async () => {
    const api = createIsolatedMockApi();
    await api.operator.createAccount();
    mount(<SetupPage />, 'admin', api);
    await screen.findByText('1 of 6 done');
  });

  it('Rules saves through the mock', async () => {
    const { api } = mount(<RulesPage />);
    await screen.findByRole('heading', { name: 'Rules' });
    const save = vi.spyOn(api.operator, 'saveRules');
    (await screen.findByRole('button', { name: /Save rule/ })).click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('Wheel lists the versions', async () => {
    mount(<WheelPage />);
    expect((await screen.findAllByRole('row')).length).toBeGreaterThan(1);
  });

  it('/operator redirects each role to its landing', async () => {
    for (const [role, to] of [
      ['admin', '/operator/setup'],
      ['staff', '/operator/operations/redemptions'],
      ['support', '/operator/insights'],
    ] as const) {
      replace.mockClear();
      mount(<OperatorIndex />, role);
      await waitFor(() => expect(replace).toHaveBeenCalledWith(to));
      cleanup();
    }
  });
});
