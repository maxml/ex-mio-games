import type { Socket } from 'socket.io';
import { WsException } from '@nestjs/websockets';
import { REALTIME_EVENTS } from '@ex-mio/shared-types';
import { NotificationsGateway } from '../notifications.gateway';
import type { RealtimeAuthService } from '../tokens';

// A mocked socket — no live socket.io server is started. `data` is a real bag
// so the gateway can stash the user and the rate-limit buckets on it.
function createSocket(
  overrides: { auth?: Record<string, unknown>; authorization?: string } = {},
): Socket {
  return {
    handshake: {
      auth: overrides.auth ?? {},
      headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    },
    data: {} as Record<string, unknown>,
    disconnect: jest.fn(),
    join: jest.fn(),
  } as unknown as Socket;
}

const authUser = { id: 'user_123', email: 'user@example.com', provider: 'custom' };

function createAuth(): jest.Mocked<RealtimeAuthService> {
  return { verifyToken: jest.fn().mockResolvedValue(authUser) };
}

describe('NotificationsGateway', () => {
  describe('handshake auth', () => {
    it('accepts a socket with a valid handshake.auth token', async () => {
      const auth = createAuth();
      const gateway = new NotificationsGateway(auth);
      const socket = createSocket({ auth: { token: 'good-token' } });

      await gateway.handleConnection(socket);

      expect(auth.verifyToken).toHaveBeenCalledWith('good-token');
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.data.user).toEqual(authUser);
      expect(socket.join).toHaveBeenCalledWith('user:user_123');
    });

    it('falls back to the Authorization bearer header', async () => {
      const auth = createAuth();
      const gateway = new NotificationsGateway(auth);
      const socket = createSocket({ authorization: 'Bearer header-token' });

      await gateway.handleConnection(socket);

      expect(auth.verifyToken).toHaveBeenCalledWith('header-token');
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects when no token is present (verifyToken never called)', async () => {
      const auth = createAuth();
      const gateway = new NotificationsGateway(auth);
      const socket = createSocket();

      await gateway.handleConnection(socket);

      expect(auth.verifyToken).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.data.user).toBeUndefined();
    });

    it('disconnects when the token is invalid', async () => {
      const auth = createAuth();
      auth.verifyToken.mockResolvedValue(null);
      const gateway = new NotificationsGateway(auth);
      const socket = createSocket({ auth: { token: 'bad-token' } });

      await gateway.handleConnection(socket);

      expect(auth.verifyToken).toHaveBeenCalledWith('bad-token');
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.data.user).toBeUndefined();
    });
  });

  describe('event handlers', () => {
    function authedSocket(): Socket {
      const socket = createSocket();
      socket.data.user = authUser;
      return socket;
    }

    it('answers ping with a pong ack echoing the client clock', () => {
      const gateway = new NotificationsGateway(createAuth());
      const ack = gateway.handlePing(authedSocket(), { at: 1000 });

      expect(ack.event).toBe(REALTIME_EVENTS.pong);
      expect(ack.at).toBe(1000);
      expect(typeof ack.serverTime).toBe('number');
    });

    it("joins the caller's own per-user room on subscribe", () => {
      const gateway = new NotificationsGateway(createAuth());
      const socket = authedSocket();

      const ack = gateway.handleSubscribe(socket, { room: 'user:user_123' });

      expect(socket.join).toHaveBeenCalledWith('user:user_123');
      expect(ack).toEqual({ ok: true, room: 'user:user_123' });
    });

    it('rejects subscribing to a foreign user room or an arbitrary room', () => {
      const gateway = new NotificationsGateway(createAuth());

      const foreign = authedSocket();
      expect(() => gateway.handleSubscribe(foreign, { room: 'user:someone_else' })).toThrow(
        new WsException('forbidden room'),
      );
      expect(foreign.join).not.toHaveBeenCalled();

      const arbitrary = authedSocket();
      expect(() => gateway.handleSubscribe(arbitrary, { room: 'orders' })).toThrow(
        new WsException('forbidden room'),
      );
      expect(arbitrary.join).not.toHaveBeenCalled();
    });

    it('rejects a payload that fails its Zod schema', () => {
      const gateway = new NotificationsGateway(createAuth());

      expect(() => gateway.handlePing(authedSocket(), { at: 'not-a-number' })).toThrow(WsException);
      expect(() => gateway.handleSubscribe(authedSocket(), { room: '' })).toThrow(WsException);
    });

    it('rejects events from an unauthenticated socket', () => {
      const gateway = new NotificationsGateway(createAuth());

      expect(() => gateway.handlePing(createSocket(), { at: 1 })).toThrow(WsException);
    });

    it('rate-limits a socket that floods one event', () => {
      const gateway = new NotificationsGateway(createAuth());
      const socket = authedSocket();

      // capacity is 20; the 21st call in the same tick exhausts the bucket.
      for (let i = 0; i < 20; i += 1) {
        gateway.handlePing(socket, {});
      }
      expect(() => gateway.handlePing(socket, {})).toThrow(WsException);
    });
  });
});
