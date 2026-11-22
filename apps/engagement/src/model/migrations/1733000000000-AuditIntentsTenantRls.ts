import type { MigrationInterface, QueryRunner } from 'typeorm';
import { addAuditIntentsTenantRls, removeAuditIntentsTenantRls } from '@ex-mio/service-kit';

/** D-31 R1: `audit_intents` holds tenant data, so it gets `tenant_id` and FORCE RLS (D-24). */
export class AuditIntentsTenantRls1733000000000 implements MigrationInterface {
  name = 'AuditIntentsTenantRls1733000000000';

  async up(q: QueryRunner): Promise<void> {
    await addAuditIntentsTenantRls(q);
  }

  async down(q: QueryRunner): Promise<void> {
    await removeAuditIntentsTenantRls(q);
  }
}
