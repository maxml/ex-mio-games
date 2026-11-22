import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  appRoleName,
  AUDIT_INTENTS_GRANTS,
  createAuditIntentsTable,
  dropAuditIntentsTable,
  grantAppRole,
  revokeAppRole,
} from '@ex-mio/service-kit';

/**
 * The shared service-kit entry point (D-21) writes an audit intent into `audit_intents` before every
 * allowed request and finalizes it afterwards. A service that takes that audit port owns the table
 * (D-23 / F4); without it every acting or internal call answers 503. The grant is its own migration
 * so the earlier grant migrations stay as they were.
 */
export class AuditIntents1732500000000 implements MigrationInterface {
  name = 'AuditIntents1732500000000';

  async up(q: QueryRunner): Promise<void> {
    await createAuditIntentsTable(q);
    await grantAppRole(q, appRoleName('engagement'), { audit_intents: AUDIT_INTENTS_GRANTS });
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('engagement'), { audit_intents: AUDIT_INTENTS_GRANTS });
    await dropAuditIntentsTable(q);
  }
}
