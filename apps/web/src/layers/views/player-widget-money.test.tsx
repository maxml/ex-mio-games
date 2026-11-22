import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MioApiError,
  MioApiProvider,
  createIsolatedMockApi,
  type MioApi,
} from '@/layers/shared/api';
import { ThemeProvider } from '@/layers/shared/ui';
import { PlayerWidgetView } from './player-widget';

// Money behaviour of the player widget: D-1 (the spin answer is the reward, the balance comes later),
// unknown outcomes (never "Nothing was charged"), and the widget's own in-flight guard.

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => vi.unstubAllGlobals());

function mount(api: MioApi, props: { recheckDelaysMs?: number[] } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MioApiProvider api={api}>
        <ThemeProvider initialId="mio">
          <PlayerWidgetView {...props} />
        </ThemeProvider>
      </MioApiProvider>
    </QueryClientProvider>,
  );
}

const balanceNow = () =>
  Number(
    (document.querySelector('[aria-live="polite"] span')?.textContent ?? '').replace(/,/g, ''),
  );

describe('D-1: the reward is pending until the balance read shows the credit', () => {
  // Mutation: compute the balance from the spin (`player.coins - holding`, or drop the
  // `Math.max(player.coins, pending.base)` floor) and this goes red.
  it('shows "+N pending" and never a smaller balance than before; ends on the credited balance', async () => {
    const api = createIsolatedMockApi();
    const realGet = api.player.getState.bind(api.player);
    let hide = 0; // payments has not credited yet: reads hide the reward this many times
    vi.spyOn(api.player, 'getState').mockImplementation(async () => {
      const s = await realGet();
      if (hide > 0 && s.lastSpin) {
        hide -= 1;
        return { ...s, coins: s.coins - s.lastSpin.coins };
      }
      return s;
    });
    mount(api);
    const button = await screen.findByRole('button', { name: 'Spin' });
    const before = balanceNow();
    hide = 3;
    const seen: number[] = [];
    const obs = new MutationObserver(() => seen.push(balanceNow()));
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/));
    const won = Number(
      /You won (\d+)/.exec(screen.getByTestId('result-live').textContent ?? '')![1],
    );
    if (won > 0) {
      expect(await screen.findByText(`+${won} pending`)).toBeInTheDocument();
      expect(balanceNow()).toBe(before);
    }
    await waitFor(() => expect(balanceNow()).toBe(before + won), { timeout: 6000 });
    obs.disconnect();
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(before);
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
  }, 12_000);
});

describe('unknown outcome of a spin', () => {
  const lost = () => new MioApiError('network-or-server', 'reply lost');

  // Mutation: tell the player "Nothing was charged" (or "No spins left") for a lost reply.
  //
  // rc review: this flaked under load (1 in 4 runs at load 18) with `toBeInTheDocument()` failing on
  // the element `findByText` had just returned. Cause, in the TEST: the re-query fired 20 ms after
  // the toast rendered; `findByText` resolves only after its own drain `setTimeout(0)`, so on a
  // starved event loop the 20 ms timer, the re-query and the re-render (toast cleared on success)
  // all ran first and the returned node was already detached. The component is correct: the toast
  // shows while the outcome is unknown and is cleared by the successful re-query. Now the re-query
  // is held on a gate the test opens only after it has seen the toast, so no timer decides the order.
  it('says the result is unknown, re-queries, and shows the result when the re-query succeeds', async () => {
    const api = createIsolatedMockApi();
    const real = api.player.spin.bind(api.player);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const spin = vi
      .spyOn(api.player, 'spin')
      .mockRejectedValueOnce(lost())
      .mockImplementation(async () => {
        await gate;
        return real();
      });
    mount(api, { recheckDelaysMs: [0] });
    fireEvent.click(await screen.findByRole('button', { name: 'Spin' }));
    await waitFor(() => expect(screen.getByText(/Result unknown/)).toBeInTheDocument());
    // the re-query is in flight (held), and the outcome is still unknown on screen
    await waitFor(() => expect(spin).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Result unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was charged|No spins left/)).not.toBeInTheDocument();
    await act(async () => open());
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/), {
      timeout: 5000,
    });
    expect(spin).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Result unknown/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing was charged|No spins left/)).not.toBeInTheDocument();
  });

  it('when it stays unknown it never claims "Nothing was charged" or "No spins left"', async () => {
    const api = createIsolatedMockApi();
    const spin = vi.spyOn(api.player, 'spin').mockRejectedValue(lost());
    mount(api, { recheckDelaysMs: [10, 10] });
    fireEvent.click(await screen.findByRole('button', { name: 'Spin' }));
    await waitFor(() => expect(spin).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/It may have been used/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was charged/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^No spins left\.$/)).not.toBeInTheDocument();
  });

  it('"No spins left." is shown only for the explicit no-credit error', async () => {
    const api = createIsolatedMockApi();
    vi.spyOn(api.player, 'spin').mockRejectedValue(new MioApiError('no_spins', 'no credit'));
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Spin' }));
    expect(await screen.findByText('No spins left.')).toBeInTheDocument();
  });
});

describe("the widget's own in-flight guard", () => {
  // Mutation: remove `inFlight.current ||` from the guard in `doSpin`. The clicks are delivered in one
  // batch (inside one act), so React has not re-rendered the busy button between them: only the ref
  // stops the second and third request while the server is still answering the first.
  it('three clicks while the server has not answered send one request', async () => {
    const api = createIsolatedMockApi();
    const real = api.player.spin.bind(api.player);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const spin = vi.spyOn(api.player, 'spin').mockImplementation(async () => {
      await gate;
      return real();
    });
    mount(api);
    const button = await screen.findByRole('button', { name: 'Spin' });
    act(() => {
      button.click();
      button.click();
      button.click();
    });
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/));
    expect(spin).toHaveBeenCalledTimes(1);
  });
});
