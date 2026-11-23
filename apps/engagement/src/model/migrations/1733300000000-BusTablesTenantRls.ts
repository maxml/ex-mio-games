import type { MigrationInterface, QueryRunner } from 'typeorm';
import { addBusTablesTenantRls, removeBusTablesTenantRls } from '@ex-mio/bus';

/**
 * Review BUS-RLS: `outbox` and `inbox` hold tenant data (the event envelope, consumed event ids) but had
 * no row-level security, so a tenant-B transaction could read, forge and update tenant A's rows. Now both
 * are FORCE RLS with the explicit platform-scan policy (like audit_intents) and tenant_id-led keys.
 * Forward migration: the table-creating migration stays as it was applied.
 */
export class BusTablesTenantRls1733300000000 implements MigrationInterface {
  name = 'BusTablesTenantRls1733300000000';

  async up(q: QueryRunner): Promise<void> {
    await addBusTablesTenantRls(q);
  }

  async down(q: QueryRunner): Promise<void> {
    await removeBusTablesTenantRls(q);
  }
}
