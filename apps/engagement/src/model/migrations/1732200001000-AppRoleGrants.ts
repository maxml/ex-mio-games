import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole, revokeAppRole, type AppGrants } from '@ex-mio/service-kit';

/**
 * The runtime role's privileges, all of them, in one place. `engagement_app` is not
 * the owner of these tables: it cannot ALTER them, DROP them or switch row-level
 * security off. A table that is not listed here is not reachable by the app.
 * A test (tests/compose roles) pins this list against the live database.
 */
export const ENGAGEMENT_APP_GRANTS: AppGrants = {
  tenant_projections: ['SELECT', 'INSERT', 'UPDATE'],
  inbox: ['SELECT', 'INSERT'], // the consumer's dedupe rows
  outbox: ['SELECT', 'INSERT', 'UPDATE'], // the relay marks rows published, parked or retried
};

export class AppRoleGrants1732200001000 implements MigrationInterface {
  name = 'AppRoleGrants1732200001000';

  async up(q: QueryRunner): Promise<void> {
    await grantAppRole(q, appRoleName('engagement'), ENGAGEMENT_APP_GRANTS);
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('engagement'), ENGAGEMENT_APP_GRANTS);
  }
}
