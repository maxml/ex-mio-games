// Reviewer probe (L5 r1). Not part of the branch; removed after the review.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MioApiProvider, createIsolatedMockApi } from '@/layers/shared/api';
import { ThemeProvider } from '@/layers/shared/ui';
import { PlayerWidgetView } from './player-widget';

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const api = createIsolatedMockApi();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MioApiProvider api={api}>
        <ThemeProvider initialId="mio">
          <PlayerWidgetView />
        </ThemeProvider>
      </MioApiProvider>
    </QueryClientProvider>,
  );
  return api;
}

describe('probe: D-1, the balance is credited later than the spin answer', () => {
  it('the shown balance never drops below the balance before the spin', async () => {
    const api = createIsolatedMockApi();
    const realGet = api.player.getState.bind(api.player);
    let lagged = 0; // coins already credited by "payments" are hidden for this many reads
    vi.spyOn(api.player, 'getState').mockImplementation(async () => {
      const s = await realGet();
      if (lagged > 0 && s.lastSpin) {
        lagged--;
        return { ...s, coins: s.coins - s.lastSpin.coins }; // engagement knows the spin, payments not yet
      }
      return s;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MioApiProvider api={api}>
          <ThemeProvider initialId="mio">
            <PlayerWidgetView />
          </ThemeProvider>
        </MioApiProvider>
      </QueryClientProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Spin' });
    const before = (await realGet()).coins;
    lagged = 1; // the first read after the spin does not have the credit yet; later reads do
    const read = () =>
      Number(
        (document.querySelector('[aria-live="polite"] span')?.textContent ?? '').replace(/,/g, ''),
      );
    const seen: number[] = [];
    const obs = new MutationObserver(() => seen.push(read()));
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/));
    const won = Number(
      /You won (\d+)/.exec(screen.getByTestId('result-live').textContent ?? '')![1],
    );
    await new Promise((r) => setTimeout(r, 2500));
    obs.disconnect();
    // (a) never shows less than the player had before the spin; (b) ends on the credited balance
    expect({ min: Math.min(...seen), end: read() }).toEqual({ min: before, end: before + won });
  }, 10_000);
});

describe('probe: http spin error mapping and idempotency', () => {
  it('500 and 409 in-flight are not "no spins"; a retry reuses the key', async () => {
    const { http: mswHttp, HttpResponse } = await import('msw');
    const { server } = await import('../../test/msw/server');
    const { createHttpClient } = await import('@/layers/shared/api/http');
    const { createHttpApi } = await import('@/layers/shared/api/mio/http');
    const api = createHttpApi(createHttpClient({ baseUrl: 'http://api.test' }));
    const keys: (string | null)[] = [];
    let status = 500;
    server.use(
      mswHttp.post('*/api/player/spins', ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return HttpResponse.json({ message: 'x', code: 'boom' }, { status });
      }),
    );
    const codes: string[] = [];
    for (const s of [500, 409]) {
      status = s;
      codes.push(
        await api.player.spin().then(
          () => 'ok',
          (e: { code: string }) => e.code,
        ),
      );
    }
    expect({ codes, sameKey: keys[0] === keys[1] }).toEqual({
      codes: ['network-or-server', 'retryable'],
      sameKey: true,
    });
  });
});

describe('probe: embed theme', () => {
  it('a known theme id sets its tokens on <html>; an unknown or hostile one falls back', async () => {
    const { EmbeddedPlayerWidget } = await import('./player-widget');
    const client = new QueryClient();
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <MioApiProvider api={createIsolatedMockApi()}>
          <EmbeddedPlayerWidget themeId="northbet" />
        </MioApiProvider>
      </QueryClientProvider>,
    );
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#f2f7f5');
    unmount();
    render(
      <QueryClientProvider client={client}>
        <MioApiProvider api={createIsolatedMockApi()}>
          <EmbeddedPlayerWidget themeId={'x;}</style><script>alert(1)</script>'} />
        </MioApiProvider>
      </QueryClientProvider>,
    );
    expect(document.documentElement.dataset.tenant).toBe('mio');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
  });
});

describe('probe: in-flight guard with a slow server', () => {
  it('two clicks while the spin request is still pending send one request', async () => {
    const api = mount();
    const real = api.player.spin.bind(api.player);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const spin = vi.spyOn(api.player, 'spin').mockImplementation(async () => {
      await gate; // the server has not answered yet
      return real();
    });
    const button = await screen.findByRole('button', { name: 'Spin' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/));
    expect(spin).toHaveBeenCalledTimes(1);
  });

  it('switching tabs away and back during and after the reveal credits nothing new', async () => {
    const api = mount();
    const button = await screen.findByRole('button', { name: 'Spin' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/));
    const after = await api.player.getState();
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole('tab', { name: 'History' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Wheel' }));
    }
    const again = await api.player.getState();
    expect([again.coins, again.spins, again.history.length]).toEqual([
      after.coins,
      after.spins,
      after.history.length,
    ]);
    expect(screen.getByTestId('result-live')).toHaveTextContent(/You won/);
  });
});
