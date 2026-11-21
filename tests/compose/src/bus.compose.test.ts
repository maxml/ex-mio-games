import { connect } from 'amqplib';
import { EventEnvelope, TenantProjection } from '@ex-mio/contracts';
import { eventually, pgAs, urls } from './env';
import { newTenant } from './player-session';

/*
 * D-24 (int/all review): the tenant is made through today's real route, operator signup
 * (`player-session.ts`), not the removed `POST /v1/tenants` with a platform header. The projection is
 * read with the operator's own engagement token. The property is unchanged: identity's outbox row
 * reaches engagement once, and a redelivery of the same event_id has no second effect.
 *
 * Mutation: drop the inbox dedupe in `@ex-mio/bus` (InboxConsumer inserts no row, or ignores the
 * conflict) -> applied_count 3 and three inbox rows.
 */

const projectionOf = async (
  headers: Record<string, string>,
): Promise<TenantProjection | undefined> => {
  const res = await fetch(`${urls.engagement}/v1/tenant-projection`, { headers });
  return res.status === 200 ? TenantProjection.parse(await res.json()) : undefined;
};

describe('bus: identity -> RabbitMQ -> engagement', () => {
  it('delivers an event, and a redelivery of the same event_id has no second effect', async () => {
    const tenant = await newTenant();
    const operator = await tenant.operatorHeaders('engagement');

    // 1. identity wrote tenant + outbox row; the relay published; engagement applied it once.
    const first = await eventually(() => projectionOf(operator));
    expect(first).toMatchObject({ tenant_id: tenant.tenantId, applied_count: 1 });

    // 2. Take the very envelope identity published and deliver it to the broker twice more.
    const identityDb = await pgAs('identity_app');
    const { rows } = await identityDb.query(
      `SELECT envelope, published_at FROM outbox WHERE tenant_id = $1 AND type = 'identity.tenant.created'`,
      [tenant.tenantId],
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
    expect((await projectionOf(operator))?.applied_count).toBe(1);
    const engagementDb = await pgAs('engagement_app');
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
