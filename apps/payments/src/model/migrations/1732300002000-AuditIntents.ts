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
 * (D-23 / F4); without it every acting or internal call answers 503. The grant is its own migration so
 * `PAYMENTS_APP_GRANTS` of the ledger migration stays as it was.
 */
export class AuditIntents1732300002000 implements MigrationInterface {
  name = 'AuditIntents1732300002000';

  async up(q: QueryRunner): Promise<void> {
    await createAuditIntentsTable(q);
    await grantAppRole(q, appRoleName('payments'), { audit_intents: AUDIT_INTENTS_GRANTS });
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('payments'), { audit_intents: AUDIT_INTENTS_GRANTS });
    await dropAuditIntentsTable(q);
  }
}
