// The widget tells the BFF it was opened once per mount (web.widget_opened). Mutation that must turn
// these red: drop the once-guard and the dependency list so the effect fires on every render.
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWidgetOpened } from './use-widget-opened';

function Probe({ token, tick }: { token?: string; tick: number }) {
  useWidgetOpened(token);
  return <span>{tick}</span>;
}

afterEach(() => vi.unstubAllGlobals());

describe('useWidgetOpened', () => {
  it('posts /api/widget/opened once per mount, however often it re-renders', () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { rerender, unmount } = render(<Probe token="h.p.s" tick={0} />);
    rerender(<Probe token="h.p.s" tick={1} />);
    rerender(<Probe token="h.p.s" tick={2} />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/widget/opened');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'h.p.s' });
    unmount();
  });

  it('a new mount posts again; no token sends an empty body; a failing request is swallowed', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const first = render(<Probe tick={0} />);
    first.unmount();
    render(<Probe tick={0} />);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({});
    await Promise.resolve();
  });
});
