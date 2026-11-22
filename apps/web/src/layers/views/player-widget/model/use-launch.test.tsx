// The embed URL's launch token is exchanged ONCE through the BFF before the widget reads any state.
// Mutation: drop the per-token cache and strict-mode style double effects send a second (refused) exchange;
// skip the exchange and the widget reads state with no session.
import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLaunch } from './use-launch';

function Probe({ token }: { token?: string }) {
  return <span data-testid="s">{useLaunch(token)}</span>;
}

afterEach(() => vi.unstubAllGlobals());

describe('useLaunch', () => {
  it('no token: ready at once, nothing is sent', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    render(<Probe />);
    expect(screen.getByTestId('s').textContent).toBe('ready');
    expect(f).not.toHaveBeenCalled();
  });

  it('a token is posted to /api/session/launch exactly once (strict mode included), then ready', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    render(
      <StrictMode>
        <Probe token="launch-token-aaaaaaaaaaaa" />
      </StrictMode>,
    );
    expect(screen.getByTestId('s').textContent).toBe('launching');
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('ready'));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/launch');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'launch-token-aaaaaaaaaaaa' });
  });

  it('a refusal is "rejected", not a hang', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"code":"LAUNCH_TOKEN_INVALID"}', { status: 401 })),
    );
    render(<Probe token="launch-token-bbbbbbbbbbbb" />);
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('rejected'));
  });
});
