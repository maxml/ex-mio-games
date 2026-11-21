import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  appRoleName,
  AUDIT_INTENTS_GRANTS,
  createAuditIntentsTable,
  dropAuditIntentsTable,
  grantAppRole,
  revokeAppRole,
  type AppGrants,
} from '@ex-mio/service-kit';

/**
 * The runtime role's privileges on the tables `IdentityCore` added, plus the D-21 `audit_intents`
 * table (the entry point's two-step audit: intent, finalize, sweeper). `identity_app` owns none of
 * them: it cannot ALTER, DROP or switch row-level security off. Widened from `AppRoleGrants`
 * (tenants gain UPDATE for status and the provider tenant id); the compose roles test pins this.
 */
export const IDENTITY_CORE_APP_GRANTS: AppGrants = {
  tenants: ['SELECT', 'INSERT', 'UPDATE'],
  users: ['SELECT', 'INSERT'],
  user_roles: ['SELECT', 'INSERT'],
  provider_links: ['SELECT', 'INSERT'],
  player_links: ['SELECT', 'INSERT', 'DELETE'], // DELETE: the erasure of the casino-id mapping (MIO-107)
  launch_jti: ['SELECT', 'INSERT', 'DELETE'],
  integration_credentials: ['SELECT', 'INSERT', 'UPDATE'],
  audit_log: ['SELECT', 'INSERT'],
  signing_keys: ['SELECT', 'INSERT', 'UPDATE'],
  audit_intents: AUDIT_INTENTS_GRANTS,
};

export class AuditIntentsAndGrants1732300001000 implements MigrationInterface {
  name = 'AuditIntentsAndGrants1732300001000';

  async up(q: QueryRunner): Promise<void> {
    await createAuditIntentsTable(q);
    await grantAppRole(q, appRoleName('identity'), IDENTITY_CORE_APP_GRANTS);
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('identity'), IDENTITY_CORE_APP_GRANTS);
    await dropAuditIntentsTable(q);
    // back to what AppRoleGrants gave
    await grantAppRole(q, appRoleName('identity'), { tenants: ['SELECT', 'INSERT'] });
  }
}
