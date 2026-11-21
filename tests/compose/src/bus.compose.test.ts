import { connect } from 'amqplib';
import { EventEnvelope, TenantProjection, uuidv7 } from '@ex-mio/contracts';
import { eventually, pgAs, PLATFORM_TOKEN, urls } from './env';

async function createTenant(slug: string): Promise<{ id: string }> {
  const res = await fetch(`${urls.identity}/v1/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-platform-admin-token': PLATFORM_TOKEN },
    body: JSON.stringify({ name: `Test ${slug}`, slug }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

const projectionOf = async (tenantId: string): Promise<TenantProjection | undefined> => {
  const res = await fetch(`${urls.engagement}/v1/tenant-projection`, {
    headers: { 'x-tenant-id': tenantId },
  });
  return res.status === 200 ? TenantProjection.parse(await res.json()) : undefined;
};

describe('bus: identity -> RabbitMQ -> engagement', () => {
  it('delivers an event, and a redelivery of the same event_id has no second effect', async () => {
    const slug = `bus-${uuidv7().slice(-12)}`;
    const tenant = await createTenant(slug);

    // 1. identity wrote tenant + outbox row; the relay published; engagement applied it once.
    const first = await eventually(() => projectionOf(tenant.id));
    expect(first).toMatchObject({ tenant_id: tenant.id, slug, applied_count: 1 });

    // 2. Take the very envelope identity published and deliver it to the broker twice more.
    const identityDb = await pgAs('identity');
    const { rows } = await identityDb.query(
      `SELECT envelope, published_at FROM outbox WHERE tenant_id = $1`,
      [tenant.id],
    );
    await identityDb.end();
    expect(rows).toHaveLength(1);
    expect(rows[0].published_at).not.toBeNull();
    const envelope = EventEnvelope.parse(rows[0].envelope);

    const conn = await connect(urls.amqp);
    const ch = await conn.createConfirmChannel();
    for (let i = 0; i < 2; i++) {
      ch.publish('mio.events', envelope.type, Buffer.from(JSON.stringify(envelope)), {
        persistent: true,
        mandatory: true,
      });
    }
    await ch.waitForConfirms();

    // 3. Wait until the queue is drained (both duplicates were consumed and acked) ...
    await eventually(async () => {
      const q = await ch.checkQueue('engagement.events');
      return q.messageCount === 0 ? true : undefined;
    });
    await new Promise((r) => setTimeout(r, 500));
    await ch.close();
    await conn.close();

    // 4. ... and the effect still ran exactly once, with exactly one inbox row.
    expect((await projectionOf(tenant.id))?.applied_count).toBe(1);
    const engagementDb = await pgAs('engagement');
    const inbox = await engagementDb.query(
      `SELECT count(*)::int AS n FROM inbox WHERE event_id = $1`,
      [envelope.event_id],
    );
    await engagementDb.end();
    expect(inbox.rows[0].n).toBe(1);
  });

  it('parks a message that is not a valid event in the dead-letter queue, not in the main queue', async () => {
    const conn = await connect(urls.amqp);
    const ch = await conn.createConfirmChannel();
    const before = (await ch.checkQueue('engagement.dlq')).messageCount;
    ch.publish(
      'mio.events',
      'identity.tenant.created',
      Buffer.from(JSON.stringify({ not: 'an envelope' })),
      { persistent: true, mandatory: true },
    );
    await ch.waitForConfirms();
    await eventually(async () => {
      const dlq = await ch.checkQueue('engagement.dlq');
      return dlq.messageCount === before + 1 ? true : undefined;
    });
    expect((await ch.checkQueue('engagement.events')).messageCount).toBe(0);
    await ch.close();
    await conn.close();
  });
});
