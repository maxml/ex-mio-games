import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MioApiProvider, createIsolatedMockApi, type MioApi } from '@/layers/shared/api';
import { ThemeProvider } from '@/layers/shared/ui';
import { OperatorConsoleView } from './operator-console';
import { PlatformAdminView } from './platform-admin';
import { PlayerWidgetView } from './player-widget';

function mount(ui: ReactElement, api: MioApi = createIsolatedMockApi()) {
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
  // Reduced motion: the wheel finishes without the long animation.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('player widget', () => {
  it('shows the balance and spins and never any odds', async () => {
    mount(<PlayerWidgetView />);
    expect(await screen.findByText('3 spins available')).toBeInTheDocument();
    expect(screen.queryByText(/probab|weight/i)).not.toBeInTheDocument();
  });

  // Mutation: remove the in-flight guard in doSpin and two requests go out (spins 3 -> 1).
  it('a double click on Spin is one request', async () => {
    const { api } = mount(<PlayerWidgetView />);
    const spin = vi.spyOn(api.player, 'spin');
    const button = await screen.findByRole('button', { name: 'Spin' });
    await userEvent.dblClick(button);
    await waitFor(() =>
      expect(screen.getByTestId('result-live')).toHaveTextContent(/You won \d+ coins/),
    );
    expect(spin).toHaveBeenCalledTimes(1);
    expect((await api.player.getState()).spins).toBe(2);
  });

  it('the balance after a spin is credited exactly once', async () => {
    const { api } = mount(<PlayerWidgetView />);
    const before = (await api.player.getState()).coins;
    await userEvent.click(await screen.findByRole('button', { name: 'Spin' }));
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/));
    const won = Number(
      /You won (\d+)/.exec(screen.getByTestId('result-live').textContent ?? '')![1],
    );
    await waitFor(async () => expect((await api.player.getState()).coins).toBe(before + won));
  });

  it('a double click on Redeem makes one redemption and the status reaches Issued without a reload', async () => {
    const { api } = mount(<PlayerWidgetView />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Bonus Store' }));
    const redeem = (await screen.findAllByRole('button', { name: 'Redeem' }))[0]!;
    await userEvent.dblClick(redeem);
    expect((await api.player.getState()).redemptions).toHaveLength(1);
    expect(await screen.findByText('Issued', {}, { timeout: 5000 })).toBeInTheDocument();
  }, 10_000);

  it('a failed reward is refunded and shown as Refunded with the coins back', async () => {
    const { api } = mount(<PlayerWidgetView />);
    await api.player.setCasinoDown(true);
    await userEvent.click(await screen.findByRole('tab', { name: 'Bonus Store' }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Redeem' }))[0]!);
    expect(await screen.findByText('+300 coins back', {}, { timeout: 8000 })).toBeInTheDocument();
    expect((await api.player.getState()).coins).toBe(420);
  }, 12_000);
});

describe('operator console', () => {
  it('Continue stays blocked until the account exists, then the plan step opens', async () => {
    mount(<OperatorConsoleView />);
    const next = await screen.findByRole('button', { name: /Continue to plan/ });
    expect(next).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Work email'), 'ops@cherry.example');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Continue to plan/ })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /Continue to plan/ }));
    expect(await screen.findByText('Choose a plan')).toBeInTheDocument();
  });

  it('a plan is paid with the test card and the step bar ticks only what is done', async () => {
    const { api } = mount(<OperatorConsoleView />);
    await api.operator.createAccount();
    await userEvent.click(await screen.findByRole('button', { name: /Plan/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose plan and pay' }));
    await userEvent.click(await screen.findByRole('button', { name: /Pay 799.00 EUR/ }));
    expect(await screen.findByText('Plan active', {}, { timeout: 5000 })).toBeInTheDocument();
    const progress = screen.getByRole('navigation', { name: 'Progress' });
    expect(within(progress).getAllByText(/\(complete/)).toHaveLength(2); // signup and plan, nothing else
  }, 10_000);

  it('a declined card shows the failure and does not activate the plan', async () => {
    const { api } = mount(<OperatorConsoleView />);
    await api.operator.createAccount();
    await userEvent.click(await screen.findByRole('button', { name: /Plan/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose plan and pay' }));
    const number = await screen.findByLabelText('Card number');
    await userEvent.clear(number);
    await userEvent.type(number, '4000 0000 0000 0002');
    await userEvent.click(screen.getByRole('button', { name: /Pay 799.00 EUR/ }));
    expect(
      await screen.findByText(/declined by the test provider/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect((await api.operator.getState()).planActive).toBe(false);
  }, 10_000);

  it('go live lists what is missing and links to those steps', async () => {
    mount(<OperatorConsoleView />);
    await userEvent.click(await screen.findByRole('button', { name: /Go live/ }));
    expect(await screen.findByText(/Still missing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay for a plan' })).toBeInTheDocument();
  });
});

describe('platform admin', () => {
  it('opening a tenant needs a reason and then appears in the audit list', async () => {
    mount(<PlatformAdminView />);
    const open = await screen.findByRole('button', { name: 'Open tenant' });
    expect(open).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason'), 'Ticket 1042: billing check');
    expect(open).toBeEnabled();
    await userEvent.click(open);
    expect(await screen.findByText(/Opened Lucky Star Casino/)).toBeInTheDocument();
  });

  it('shows the funnel and MRR from the overview', async () => {
    mount(<PlatformAdminView />);
    expect(await screen.findByText('MRR')).toBeInTheDocument();
    expect(screen.getByText('Operator funnel')).toBeInTheDocument();
  });
});
