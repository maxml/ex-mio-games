import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D-31 R2 (INV-ENV-SCHEMA-2): the `inbound_events` primary key names the environment too, so every
 * key of the table includes it. This was first edited into the applied migration 1732800000000; that
 * migration is restored and the change ships here, as a forward step. Idempotent: a database that
 * already ran the edited 1732800000000 has the key (tenant_id, sandbox, id) and is left alone.
 */
export class InboundEventsEnvKey1733000001000 implements MigrationInterface {
  name = 'InboundEventsEnvKey1733000001000';

  async up(q: QueryRunner): Promise<void> {
    const rows: { cols: string[] }[] = await q.query(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = 'inbound_events'::regclass AND i.indisprimary`,
    );
    if ((rows[0]?.cols ?? []).join(',') === 'tenant_id,sandbox,id') return;
    await q.query(`ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_pkey"`);
    await q.query(`ALTER TABLE "inbound_events" ADD PRIMARY KEY ("tenant_id", "sandbox", "id")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_pkey"`);
    await q.query(`ALTER TABLE "inbound_events" ADD PRIMARY KEY ("tenant_id", "id")`);
  }
}
