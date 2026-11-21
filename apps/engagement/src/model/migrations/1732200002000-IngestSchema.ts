import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole, revokeAppRole, type AppGrants } from '@ex-mio/service-kit';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/**
 * Ingest, rules and wheel schema (docs/specs/engagement-ingest.md section 10) and the exact grants
 * of the runtime role `engagement_app` on these tables. The migration runs as the OWNER role; the
 * app role owns nothing, so it cannot drop or disable the trigger, switch row-level security off or
 * grant itself anything. The fairness and audit record is immutable to it: no UPDATE or DELETE on
 * reward_tables, rules, spins and inbound_events; spin_credits may only change `status` and
 * `used_at`, and the trigger refuses `used -> available`.
 *
 * Every primary key leads with `tenant_id` (review F2, the roles test requires it of every unique
 * key of a tenant table), and `spins` reference their credit by (tenant_id, id), so a spin cannot
 * point at another tenant's credit. Grants go through `grantAppRole`; the bus tables' grants are
 * `AppRoleGrants1732200001000`'s.
 */
export const ENGAGEMENT_INGEST_GRANTS: AppGrants = {
  inbound_events: ['SELECT', 'INSERT'],
  rules: ['SELECT', 'INSERT'],
  reward_tables: ['SELECT', 'INSERT'], // the compose seed inserts a table as the app role
  spin_credits: ['SELECT', 'INSERT'], // plus the column grant UPDATE (status, used_at) below
  spins: ['SELECT', 'INSERT'],
};
const APP = appRoleName('engagement');
const TABLES = ['inbound_events', 'rules', 'reward_tables', 'spin_credits', 'spins'] as const;

export class IngestSchema1732200002000 implements MigrationInterface {
  name = 'IngestSchema1732200002000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "inbound_events" (
        "id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "source" text NOT NULL,
        "external_event_id" text NOT NULL,
        "external_player_hmac" text NOT NULL,
        "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
        "currency" text NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        UNIQUE ("tenant_id", "source", "external_event_id")
      )`);
    await q.query(`
      CREATE TABLE "rules" (
        "tenant_id" uuid NOT NULL,
        "rule_id" text NOT NULL,
        "version" integer NOT NULL CHECK ("version" > 0),
        "definition" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("tenant_id", "rule_id", "version")
      )`);
    await q.query(`
      CREATE TABLE "reward_tables" (
        "tenant_id" uuid NOT NULL,
        "wheel_id" uuid NOT NULL,
        "version" integer NOT NULL CHECK ("version" > 0),
        "definition" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("tenant_id", "wheel_id", "version")
      )`);
    await q.query(`
      CREATE TABLE "spin_credits" (
        "id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        -- X-3 / D-13: a credit granted from a sandbox deposit is a sandbox credit, and so is its spin.
        "sandbox" boolean NOT NULL DEFAULT false,
        "wheel_id" uuid NOT NULL,
        "source_event_id" uuid NOT NULL,
        "rule_id" text NOT NULL,
        "rule_version" integer NOT NULL,
        "seq" integer NOT NULL CHECK ("seq" >= 0),
        "status" text NOT NULL DEFAULT 'available' CHECK ("status" IN ('available', 'used')),
        "used_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        UNIQUE ("tenant_id", "source_event_id", "rule_id", "seq")
      )`);
    await q.query(
      `CREATE INDEX "spin_credits_available" ON "spin_credits" ("tenant_id", "user_id", "created_at", "id")
         WHERE "status" = 'available'`,
    );
    await q.query(`
      CREATE TABLE "spins" (
        "id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "credit_id" uuid NOT NULL,
        "operation_id" text NOT NULL,
        "seed_version" integer NOT NULL,
        "table_version" integer NOT NULL,
        "hmac" text NOT NULL,
        "segment_index" integer NOT NULL CHECK ("segment_index" >= 0),
        "segment_label" text NOT NULL,
        "reward_coins" integer NOT NULL CHECK ("reward_coins" >= 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        FOREIGN KEY ("tenant_id", "credit_id") REFERENCES "spin_credits" ("tenant_id", "id"),
        UNIQUE ("tenant_id", "user_id", "operation_id")
      )`);
    for (const t of TABLES) await enableTenantRls(q, t);

    // No way back: a used credit never becomes available again, whoever asks.
    await q.query(`
      CREATE FUNCTION spin_credits_no_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'used' AND NEW.status <> 'used' THEN
          RAISE EXCEPTION 'a used spin credit cannot become available again';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER spin_credits_no_reopen BEFORE UPDATE ON "spin_credits"
        FOR EACH ROW EXECUTE FUNCTION spin_credits_no_reopen()`);

    // The runtime role's privileges on these tables, all of them (a table not listed is unreachable
    // for the app), then the one column grant a table-level grant cannot express.
    await grantAppRole(q, APP, ENGAGEMENT_INGEST_GRANTS);
    await q.query(`GRANT UPDATE ("status", "used_at") ON "spin_credits" TO ${APP}`);
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, APP, ENGAGEMENT_INGEST_GRANTS);
    await q.query(`DROP TRIGGER spin_credits_no_reopen ON "spin_credits"`);
    await q.query(`DROP FUNCTION spin_credits_no_reopen()`);
    for (const t of [...TABLES].reverse()) {
      await disableTenantRls(q, t);
      await q.query(`DROP TABLE "${t}"`);
    }
  }
}
