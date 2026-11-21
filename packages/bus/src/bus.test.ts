import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { createEvent } from '@ex-mio/contracts';
import { enqueueEvent, InboxConsumer, OutboxRelay } from './index';

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
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('INSERT INTO "inbox"')) {
        const key = String(params?.[1]);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ event_id: key }];
      }
      return [];
    }),
  };
  return {
    transaction: async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager),
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
    const query = jest.fn();
    await enqueueEvent({ query } as never, event);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO "outbox"');
    expect(query.mock.calls[0][1][0]).toBe(event.event_id);
  });

  function relayWith(
    rows: { event_id: string; type: string; envelope: unknown }[],
    returnedIds: string[],
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
    return { relay: new OutboxRelay({ dataSource, channel }), channel, manager, queries };
  }

  it('marks rows published only after the broker confirmed them', async () => {
    const { relay, channel, manager } = relayWith(
      [{ event_id: event.event_id, type: event.type, envelope: event }],
      [],
    );
    expect(await relay.pollOnce()).toBe(1);
    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls.at(-1)?.[0]).toContain('UPDATE "outbox"');
  });

  it('leaves an unroutable (returned) event unpublished so it is retried', async () => {
    const { relay, queries } = relayWith(
      [{ event_id: event.event_id, type: event.type, envelope: event }],
      [event.event_id],
    );
    expect(await relay.pollOnce()).toBe(0);
    expect(queries.some((q) => q.includes('UPDATE "outbox"'))).toBe(false);
  });
});
