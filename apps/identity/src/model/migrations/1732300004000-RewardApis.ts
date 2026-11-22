import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole, revokeAppRole } from '@ex-mio/service-kit';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/**
 * D-27: where MIO calls a casino to issue a reward, per tenant, casino and environment. The secret
 * that signs those calls is sealed with the credentials KEK, like the integration secrets; the
 * integration route serves it to engagement only. The key leads with `tenant_id`.
 */
export const REWARD_APIS_GRANTS = { reward_apis: ['SELECT', 'INSERT', 'UPDATE'] } as const;

export class RewardApis1732300004000 implements MigrationInterface {
  name = 'RewardApis1732300004000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "reward_apis" (
        "tenant_id" uuid NOT NULL,
        "platform" text NOT NULL,
        "environment" text NOT NULL CHECK ("environment" IN ('production', 'sandbox')),
        "base_url" text NOT NULL,
        "api_key_enc" text,
        "issue_deadline_ms" integer,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "platform", "environment")
      )`);
    await enableTenantRls(q, 'reward_apis');
    await grantAppRole(q, appRoleName('identity'), REWARD_APIS_GRANTS);
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('identity'), REWARD_APIS_GRANTS);
    await disableTenantRls(q, 'reward_apis');
    await q.query(`DROP TABLE "reward_apis"`);
  }
}
