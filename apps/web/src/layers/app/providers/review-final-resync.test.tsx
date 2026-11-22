import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { disconnectWsClient } from '@/layers/shared/api';
import { useConnectionStore } from '@/layers/shared/lib';
import { createFakeSocket, type FakeSocket } from '../../../test/fake-socket';
import { createTestQueryClient } from '../../../test/utils';
import { WSProvider } from './WSProvider';

/*
 * Final review, starter cross-check item 11. Connection-state recovery is off on the server (D-10,
 * pinned by RECOVERY-OFF in realtime.gateway.test.ts) and there is no (epoch, id) replay cursor, so
 * every push sent while the socket was down is lost. D-10's answer is "the client resyncs over REST
 * after a reconnect". WSProvider's `connect` handler only sets the status: nothing is refetched, so
 * a balance or redemption change pushed during the gap stays stale on screen until something else
 * refetches it.
 *
 * RED at a4d97bb. Mutation for the fix: remove the resync from the reconnect handler -> red.
 */

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

describe('final review: realtime resync after a reconnect (D-10, starter item 11)', () => {
  it('RESYNC-1 a reconnect after a drop refetches the server state over REST', () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const refetch = vi.spyOn(queryClient, 'refetchQueries').mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={queryClient}>
        <WSProvider getToken={() => 'tok'}>
          <div>child</div>
        </WSProvider>
      </QueryClientProvider>,
    );
    fake.__emit('connect');
    invalidate.mockClear();
    refetch.mockClear();

    // the transport drops, the Manager reconnects, the socket connects again
    fake.__emit('disconnect', 'transport close');
    fake.__emitManager('reconnect_attempt');
    fake.__emit('connect');

    expect(invalidate.mock.calls.length + refetch.mock.calls.length).toBeGreaterThan(0);
  });
});
