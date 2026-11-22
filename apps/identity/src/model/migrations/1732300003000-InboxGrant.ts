import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole, revokeAppRole } from '@ex-mio/service-kit';

/**
 * Identity consumes `audit.acting_request` and `audit.service_call` (D-11, D-14) through an
 * `InboxConsumer`, which inserts into `inbox`. The runtime role had no grant on it, so every
 * consumed audit event failed with "permission denied" and no `audit_log` row was ever written.
 * This is the same grant every other consumer has (review finding F2).
 */
export const IDENTITY_INBOX_GRANTS = { inbox: ['SELECT', 'INSERT'] } as const;

export class InboxGrant1732300003000 implements MigrationInterface {
  name = 'InboxGrant1732300003000';

  async up(q: QueryRunner): Promise<void> {
    await grantAppRole(q, appRoleName('identity'), IDENTITY_INBOX_GRANTS);
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('identity'), IDENTITY_INBOX_GRANTS);
  }
}
