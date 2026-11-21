import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { createEvent } from '@ex-mio/contracts';
import {
  backoffMs,
  enqueueEvent,
  InboxConsumer,
  isTransientError,
  OutboxRelay,
  OutboxTenantMismatchError,
  replayDeadLetters,
  TransientError,
} from './index';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const event = createEvent({
  type: 'identity.tenant.created',
  tenantId: TENANT,
  payload: { name: 'Acme', slug: 'acme' },
});

function message(content: unknown): ConsumeMessage {
  return {
    content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
    properties: { messageId: 'm1' },
  } as unknown as ConsumeMessage;
}

/** A DataSource whose inbox insert reports "inserted" the first time only. */
function inboxDataSource(log: string[]) {
  const seen = new Set<string>();
  let added: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('INSERT INTO "inbox"')) {
        const key = String(params?.[1]);
        if (seen.has(key)) return [];
        seen.add(key);
        added.push(key);
        return [{ event_id: key }];
      }
      return [];
    }),
  };
  return {
    transaction: async (fn: (m: typeof manager) => Promise<unknown>) => {
      added = [];
      try {
        return await fn(manager);
      } catch (err) {
        for (const key of added) seen.delete(key); // a rolled-back transaction leaves no inbox row
        throw err;
      }
    },
  } as unknown as DataSource;
}

function fakeChannel() {
  return { ack: jest.fn(), reject: jest.fn() } as unknown as Channel & {
    ack: jest.Mock;
    reject: jest.Mock;
  };
}

describe('InboxConsumer', () => {
  it('applies a new event once and acks; a redelivery is acked without the effect', async () => {
    const channel = fakeChannel();
    const effect = jest.fn(async () => undefined);
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource([]),
      channel,
      consumer: 'engagement',
      handler: effect,
    });
    expect(await consumer.onMessage(message(event))).toBe('applied');
    expect(await consumer.onMessage(message(event))).toBe('duplicate');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(2);
    expect(channel.reject).not.toHaveBeenCalled();
  });

  it('rejects without requeue a message that is not a valid event', async () => {
    const channel = fakeChannel();
    const effect = jest.fn();
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource([]),
      channel,
      consumer: 'engagement',
      handler: effect,
    });
    expect(await consumer.onMessage(message('not json'))).toBe('rejected');
    expect(await consumer.onMessage(message({ ...event, tenant_id: undefined }))).toBe('rejected');
    expect(effect).not.toHaveBeenCalled();
    expect(channel.reject).toHaveBeenCalledWith(expect.anything(), false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('rejects without requeue when the handler throws', async () => {
    const channel = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource([]),
      channel,
      consumer: 'engagement',
      handler: async () => {
        throw new Error('boom');
      },
    });
    expect(await consumer.onMessage(message(event))).toBe('rejected');
    expect(channel.reject).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('retries a transient failure with a delay and requeues it; it is not dead-lettered yet', async () => {
    const channel = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource([]),
      channel,
      consumer: 'engagement',
      retry: { baseMs: 1, maxMs: 2, maxAttempts: 3 },
      handler: async () => {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      },
    });
    expect(await consumer.onMessage(message(event))).toBe('retried');
    expect(channel.reject).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it('dead-letters a transient failure once the retries are used up', async () => {
    const channel = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource([]),
      channel,
      consumer: 'engagement',
      retry: { baseMs: 1, maxMs: 2, maxAttempts: 3 },
      handler: async () => {
        throw new TransientError('db down');
      },
    });
    const outcomes = [
      await consumer.onMessage(message(event)),
      await consumer.onMessage(message(event)),
      await consumer.onMessage(message(event)),
    ];
    expect(outcomes).toEqual(['retried', 'retried', 'rejected']);
    expect(channel.reject).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('dead-letters a permanent failure on the first attempt', async () => {
    const channel = fakeChannel();
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource([]),
      channel,
      consumer: 'engagement',
      handler: async () => {
        throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      },
    });
    expect(await consumer.onMessage(message(event))).toBe('rejected');
    expect(channel.reject).toHaveBeenCalledTimes(1);
    expect(channel.reject).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('sets the tenant before the handler runs', async () => {
    const log: string[] = [];
    const consumer = new InboxConsumer({
      dataSource: inboxDataSource(log),
      channel: fakeChannel(),
      consumer: 'engagement',
      handler: async () => undefined,
    });
    await consumer.onMessage(message(event));
    expect(log[0]).toBe('SET LOCAL app.tenant_id');
    expect(log[1]).toBe('INSERT INTO "inbox"');
  });
});

describe('outbox', () => {
  it('enqueueEvent writes through the given manager (same transaction as the caller)', async () => {
    const query = jest.fn(async (sql: string) =>
      sql.startsWith('SELECT') ? [{ tenant: null }] : [],
    );
    await enqueueEvent({ query } as never, event);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO "outbox"');
    expect((query.mock.calls[1] as unknown as unknown[][])[1][0]).toBe(event.event_id);
  });

  it('enqueueEvent refuses an event of another tenant than the transaction tenant', async () => {
    const query = jest.fn(async (sql: string) =>
      sql.startsWith('SELECT') ? [{ tenant: '0190a1b2-c3d4-4e5f-8a6b-000000000000' }] : [],
    );
    await expect(enqueueEvent({ query } as never, event)).rejects.toBeInstanceOf(
      OutboxTenantMismatchError,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  function relayWith(
    rows: { event_id: string; type: string; envelope: unknown; attempts: number }[],
    returnedIds: string[],
    relayOptions: { retry?: { baseMs: number; maxMs: number; maxAttempts: number } } = {},
    onParked?: (row: unknown) => void,
  ) {
    const queries: string[] = [];
    const handlers: Record<string, (m: unknown) => void> = {};
    const channel = {
      on: (name: string, fn: (m: unknown) => void) => void (handlers[name] = fn),
      publish: jest.fn(),
      waitForConfirms: jest.fn(async () => {
        for (const id of returnedIds) handlers.return?.({ properties: { messageId: id } });
      }),
    } as unknown as ConfirmChannel & { publish: jest.Mock };
    const manager = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return sql.startsWith('SELECT') ? rows : [];
      }),
    };
    const dataSource = {
      transaction: async (fn: (m: typeof manager) => Promise<number>) => fn(manager),
    } as unknown as DataSource;
    return {
      relay: new OutboxRelay({ dataSource, channel, ...relayOptions, onParked }),
      channel,
      manager,
      queries,
    };
  }

  it('marks rows published only after the broker confirmed them', async () => {
    const { relay, channel, manager } = relayWith(
      [{ event_id: event.event_id, type: event.type, envelope: event, attempts: 0 }],
      [],
    );
    expect(await relay.pollOnce()).toBe(1);
    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls.at(-1)?.[0]).toContain('UPDATE "outbox"');
  });

  it('keeps an unroutable (returned) event unpublished and schedules its own retry', async () => {
    const { relay, manager } = relayWith(
      [{ event_id: event.event_id, type: event.type, envelope: event, attempts: 0 }],
      [event.event_id],
    );
    expect(await relay.pollOnce()).toBe(0);
    const updates = manager.query.mock.calls.filter((c) =>
      String(c[0]).includes('UPDATE "outbox"'),
    );
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).not.toContain('"published_at" = now()');
    expect(String(updates[0][0])).toContain('"next_attempt_at"');
  });

  it('parks a row on its last attempt and reports it', async () => {
    const parked: unknown[] = [];
    const { relay, manager } = relayWith(
      [{ event_id: event.event_id, type: event.type, envelope: event, attempts: 2 }],
      [event.event_id],
      { retry: { baseMs: 1, maxMs: 1, maxAttempts: 3 } },
      (row) => parked.push(row),
    );
    await relay.pollOnce();
    const update = manager.query.mock.calls.find((c) =>
      String(c[0]).includes('"parked_at" = CASE'),
    );
    expect((update?.[1] as unknown[])[4]).toBe(true);
    expect(parked).toEqual([{ eventId: event.event_id, type: event.type, attempts: 3 }]);
  });
});

describe('retry helpers', () => {
  it('backs off exponentially up to the cap', () => {
    const o = { baseMs: 100, maxMs: 1000 };
    expect([1, 2, 3, 4, 5, 50].map((a) => backoffMs(a, o))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  it('tells transient failures from permanent ones', () => {
    for (const code of ['40001', '40P01', '57P01', '08006', 'ECONNREFUSED', 'ETIMEDOUT']) {
      expect(isTransientError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
    expect(isTransientError({ driverError: { code: '40001' } })).toBe(true);
    expect(isTransientError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientError(new TransientError('later'))).toBe(true);
    for (const code of ['23505', '23514', '42P01', '22P02']) {
      expect(isTransientError(Object.assign(new Error('x'), { code }))).toBe(false);
    }
    expect(isTransientError(new Error('unknown event type'))).toBe(false);
  });
});

describe('replayDeadLetters', () => {
  function dlqChannel(messages: string[]) {
    const queue = [...messages];
    const sent: { queue: string; body: string }[] = [];
    const acked: unknown[] = [];
    const channel = {
      checkQueue: jest.fn(async () => ({ messageCount: queue.length })),
      get: jest.fn(async () => {
        const body = queue.shift();
        return body === undefined
          ? false
          : { content: Buffer.from(body), properties: { messageId: `id-${body}` } };
      }),
      sendToQueue: jest.fn(
        (q: string, content: Buffer) => void sent.push({ queue: q, body: String(content) }),
      ),
      waitForConfirms: jest.fn(async () => undefined),
      ack: jest.fn((m: unknown) => void acked.push(m)),
    } as unknown as ConfirmChannel;
    return { channel, sent, acked };
  }

  it('moves every dead letter back to the service queue and acks each after the confirm', async () => {
    const { channel, sent, acked } = dlqChannel(['a', 'b']);
    expect(await replayDeadLetters(channel, 'payments')).toEqual({ depth: 2, replayed: 2 });
    expect(sent).toEqual([
      { queue: 'payments.events', body: 'a' },
      { queue: 'payments.events', body: 'b' },
    ]);
    expect(acked).toHaveLength(2);
  });

  it('honours the limit, and a dry run moves nothing', async () => {
    const one = dlqChannel(['a', 'b', 'c']);
    expect(await replayDeadLetters(one.channel, 'payments', { limit: 1 })).toEqual({
      depth: 3,
      replayed: 1,
    });
    const dry = dlqChannel(['a', 'b']);
    expect(await replayDeadLetters(dry.channel, 'payments', { dryRun: true })).toEqual({
      depth: 2,
      replayed: 0,
    });
    expect(dry.sent).toHaveLength(0);
  });
});
