import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { disconnectWsClient, queryKeys } from '@/layers/shared/api';
import { useConnectionStore } from '@/layers/shared/lib';
import { createFakeSocket, type FakeSocket } from '../../../test/fake-socket';
import { createTestQueryClient } from '../../../test/utils';
import { WSProvider, applyNotificationToCache } from './WSProvider';

// Mock the transport: the provider exercises the real client + cache mapping
// against a fake socket, no live gateway (R3 acceptance).
vi.mock('socket.io-client', () => ({ io: vi.fn() }));
const mockedIo = vi.mocked(io);

let fake: FakeSocket;

beforeEach(() => {
  fake = createFakeSocket();
  mockedIo.mockReturnValue(fake as unknown as ReturnType<typeof io>);
});

afterEach(() => {
  disconnectWsClient();
  useConnectionStore.getState().reset();
});

function renderProvider() {
  const queryClient = createTestQueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const setData = vi.spyOn(queryClient, 'setQueryData');
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <WSProvider getToken={() => 'tok'}>
        <div>child</div>
      </WSProvider>
    </QueryClientProvider>,
  );
  return { queryClient, invalidate, setData, ...utils };
}

describe('WSProvider', () => {
  it('opens the singleton socket on mount and tracks the connection lifecycle', () => {
    renderProvider();

    expect(mockedIo).toHaveBeenCalledTimes(1);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(useConnectionStore.getState().status).toBe('connecting');

    fake.__emit('connect');
    expect(useConnectionStore.getState().status).toBe('open');
  });

  it('connects SAME-ORIGIN when NEXT_PUBLIC_API_URL is unset (realtime ON, not off)', () => {
    const previous = process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    try {
      renderProvider();

      // The domain-agnostic image (no baked NEXT_PUBLIC_API_URL) still opens a
      // socket: the origin resolves to the current page (same origin), so the
      // provider connects rather than degrading to "realtime off".
      expect(mockedIo).toHaveBeenCalledTimes(1);
      const [url] = mockedIo.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe(`ws://${window.location.host}/rt`);
      expect(fake.connect).toHaveBeenCalledTimes(1);
      expect(useConnectionStore.getState().status).toBe('connecting');
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_API_URL = previous;
    }
  });

  it('marks the store reconnecting on a Manager reconnect attempt', () => {
    renderProvider();
    fake.__emit('connect');

    fake.__emitManager('reconnect_attempt');
    expect(useConnectionStore.getState().status).toBe('reconnecting');
  });

  it('records the error message on a failed handshake', () => {
    renderProvider();

    fake.__emit('connect_error', new Error('unauthorized'));
    expect(useConnectionStore.getState().lastError).toBe('unauthorized');
  });

  it('invalidates the matching query on an inbound notification', () => {
    const { invalidate } = renderProvider();
    fake.__emit('connect');

    fake.__emit('notification', { id: 'n1', type: 'users.created', payload: {}, ts: 1 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.users.all });
  });

  it('patches the cache via setQueryData for a high-frequency event', () => {
    const { setData } = renderProvider();
    fake.__emit('connect');

    fake.__emit('notification', {
      id: 'n2',
      type: 'health.status',
      payload: { status: 'ok' },
      ts: 2,
    });
    expect(setData).toHaveBeenCalledWith(queryKeys.health.status(), { status: 'ok' });
  });

  it('ignores a malformed frame (Zod rejection) — no cache write', () => {
    const { invalidate, setData } = renderProvider();
    fake.__emit('connect');

    fake.__emit('notification', { id: 'bad' }); // missing type/ts
    expect(invalidate).not.toHaveBeenCalled();
    expect(setData).not.toHaveBeenCalled();
  });
});

describe('applyNotificationToCache', () => {
  it('invalidates the users root by default and patches health.status in place', () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const setData = vi.spyOn(queryClient, 'setQueryData');

    applyNotificationToCache(queryClient, { id: 'a', type: 'users.created', payload: {}, ts: 1 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.users.all });

    applyNotificationToCache(queryClient, {
      id: 'b',
      type: 'health.status',
      payload: { up: true },
      ts: 2,
    });
    expect(setData).toHaveBeenCalledWith(queryKeys.health.status(), { up: true });
  });
});
