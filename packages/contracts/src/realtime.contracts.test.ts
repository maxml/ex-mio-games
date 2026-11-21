import * as publicApi from './index';
import {
  NotificationEnvelope,
  PingInput,
  PongAck,
  REALTIME_EVENTS,
  REALTIME_NAMESPACE,
  SubscribeAck,
  SubscribeInput,
} from './index';

describe('contracts realtime public contract waist', () => {
  it('exports every documented realtime schema and constant from the package barrel', () => {
    expect(publicApi).toEqual(
      expect.objectContaining({
        REALTIME_NAMESPACE,
        REALTIME_EVENTS,
        PingInput,
        SubscribeInput,
        PongAck,
        SubscribeAck,
        NotificationEnvelope,
      }),
    );
  });

  it('keeps the documented realtime envelope stable', () => {
    expect(REALTIME_NAMESPACE).toBe('notifications');
    expect(REALTIME_EVENTS).toEqual({
      ping: 'ping',
      pong: 'pong',
      subscribe: 'subscribe',
      notification: 'notification',
    });

    expect(PingInput.parse({ at: 1 })).toEqual({ at: 1 });
    expect(SubscribeInput.safeParse({ room: '' }).success).toBe(false);
    expect(SubscribeInput.parse({ room: 'user:user-1' })).toEqual({ room: 'user:user-1' });
    expect(PongAck.parse({ event: 'pong', at: null, serverTime: 2 })).toEqual({
      event: 'pong',
      at: null,
      serverTime: 2,
    });
    expect(SubscribeAck.parse({ ok: true, room: 'user:user-1' })).toEqual({
      ok: true,
      room: 'user:user-1',
    });
    expect(
      NotificationEnvelope.parse({
        id: 'notification-1',
        type: 'example.created',
        payload: { ok: true },
        ts: 3,
      }),
    ).toEqual({
      id: 'notification-1',
      type: 'example.created',
      payload: { ok: true },
      ts: 3,
    });
  });
});
