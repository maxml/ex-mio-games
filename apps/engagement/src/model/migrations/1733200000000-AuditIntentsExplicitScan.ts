import type { MigrationInterface, QueryRunner } from 'typeorm';
import { loosenAuditIntentsPolicy, tightenAuditIntentsPolicy } from '@ex-mio/service-kit';

/**
 * Re-review 2 F1 (D-32): the `audit_intents` policy was `tenant OR no tenant`, so a connection with no
 * tenant read every tenant's rows. Now the platform branch needs the explicit `app.platform_scan` flag
 * AND no tenant, like the work queue. Forward migration: 1733000000000 stays as it was applied.
 */
export class AuditIntentsExplicitScan1733200000000 implements MigrationInterface {
  name = 'AuditIntentsExplicitScan1733200000000';

  async up(q: QueryRunner): Promise<void> {
    await tightenAuditIntentsPolicy(q);
  }

  async down(q: QueryRunner): Promise<void> {
    await loosenAuditIntentsPolicy(q);
  }
}
