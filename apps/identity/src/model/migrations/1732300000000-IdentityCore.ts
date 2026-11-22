import type { MigrationInterface, QueryRunner } from 'typeorm';
import { PLATFORM_TENANT_ID } from '@ex-mio/contracts';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/** Tenant tables (carry `tenant_id`): row-level security is enabled, forced and has WITH CHECK. */
const TENANT_TABLES = [
  'users',
  'user_roles',
  'provider_links',
  'player_links',
  'launch_jti',
  'integration_credentials',
  'audit_log',
];

export class IdentityCore1732300000000 implements MigrationInterface {
  name = 'IdentityCore1732300000000';

  async up(q: QueryRunner): Promise<void> {
    // The tenant registry becomes the full tenant table: type, status, registered domains.
    await q.query(`
      ALTER TABLE "tenants"
        ADD COLUMN "type" text NOT NULL DEFAULT 'operator' CHECK ("type" IN ('platform', 'operator')),
        ADD COLUMN "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'suspended')),
        ADD COLUMN "domains" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN "provider_tenant_id" text`);
    // Exactly one platform tenant, enforced by the schema.
    await q.query(
      `CREATE UNIQUE INDEX "tenants_one_platform" ON "tenants" ("type") WHERE "type" = 'platform'`,
    );
    await q.query(`CREATE INDEX "tenants_domains" ON "tenants" USING gin ("domains")`);
    // The platform tenant has a fixed id: the token verifier binds platform_admin to it.
    await q.query(
      `INSERT INTO "tenants" ("id", "type", "name", "slug", "status") VALUES ($1, 'platform', 'Platform', 'platform', 'active')`,
      [PLATFORM_TENANT_ID],
    );

    await q.query(`
      CREATE TABLE "users" (
        "tenant_id" uuid NOT NULL REFERENCES "tenants" ("id"),
        "id" uuid NOT NULL,
        "email" text,
        "kind" text NOT NULL CHECK ("kind" IN ('staff', 'player')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "users_tenant_email" ON "users" ("tenant_id", lower("email")) WHERE "email" IS NOT NULL`,
    );
    await q.query(`
      CREATE TABLE "user_roles" (
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" text NOT NULL CHECK ("role" IN ('platform_admin', 'operator_admin', 'operator_staff', 'player')),
        PRIMARY KEY ("tenant_id", "user_id", "role"),
        FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users" ("tenant_id", "id")
      )`);
    await q.query(`
      CREATE TABLE "provider_links" (
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "provider" text NOT NULL,
        "provider_uid" text NOT NULL,
        PRIMARY KEY ("tenant_id", "user_id"),
        UNIQUE ("tenant_id", "provider", "provider_uid"),
        FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users" ("tenant_id", "id")
      )`);
    await q.query(`
      CREATE TABLE "player_links" (
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "platform" text NOT NULL,
        "external_player_id" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "user_id"),
        UNIQUE ("tenant_id", "platform", "external_player_id"),
        FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users" ("tenant_id", "id")
      )`);
    await q.query(`
      CREATE TABLE "launch_jti" (
        "tenant_id" uuid NOT NULL REFERENCES "tenants" ("id"),
        "jti" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        PRIMARY KEY ("tenant_id", "jti")
      )`);
    await q.query(`
      CREATE TABLE "integration_credentials" (
        "tenant_id" uuid NOT NULL REFERENCES "tenants" ("id"),
        "key_id" text NOT NULL,
        "platform" text NOT NULL,
        "api_key_hash" text NOT NULL,
        "secret_enc" text NOT NULL,
        "status" text NOT NULL CHECK ("status" IN ('active', 'retiring', 'revoked')),
        "retiring_until" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "key_id"),
        UNIQUE ("tenant_id", "api_key_hash")
      )`);
    // No foreign key on the actor columns: the actor may belong to another tenant (the platform).
    await q.query(`
      CREATE TABLE "audit_log" (
        "tenant_id" uuid NOT NULL REFERENCES "tenants" ("id"),
        "id" uuid NOT NULL,
        "occurred_at" timestamptz NOT NULL DEFAULT now(),
        "actor_user_id" uuid,
        "actor_tenant_id" uuid,
        "acting_tenant_id" uuid,
        "action" text NOT NULL,
        "reason" text NOT NULL DEFAULT '',
        "service" text,
        "route" text,
        "decision" text,
        "caller_service" text,
        PRIMARY KEY ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE INDEX "audit_log_tenant_time" ON "audit_log" ("tenant_id", "occurred_at", "id")`,
    );
    // Platform table (no tenant_id): the signing keys, private part sealed with CREDENTIALS_KEK.
    await q.query(`
      CREATE TABLE "signing_keys" (
        "kid" text PRIMARY KEY,
        "public_jwk" jsonb NOT NULL,
        "private_enc" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "retired" boolean NOT NULL DEFAULT false
      )`);

    for (const table of TENANT_TABLES) await enableTenantRls(q, table);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of [...TENANT_TABLES].reverse()) await disableTenantRls(q, table);
    for (const table of [
      'signing_keys',
      'audit_log',
      'integration_credentials',
      'launch_jti',
      'player_links',
      'provider_links',
      'user_roles',
      'users',
    ]) {
      await q.query(`DROP TABLE "${table}"`);
    }
    await q.query(`DELETE FROM "tenants" WHERE "id" = $1`, [PLATFORM_TENANT_ID]);
    await q.query(`DROP INDEX "tenants_domains"`);
    await q.query(`DROP INDEX "tenants_one_platform"`);
    await q.query(
      `ALTER TABLE "tenants" DROP COLUMN "provider_tenant_id", DROP COLUMN "domains", DROP COLUMN "status", DROP COLUMN "type"`,
    );
  }
}
