import type { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/**
 * Ingest, rules and wheel schema (docs/specs/engagement-ingest.md section 10) and the exact grants
 * of the runtime role `engagement_app`. The migration runs as the OWNER role; the app role owns
 * nothing, so it cannot drop or disable the trigger, switch row-level security off or grant itself
 * anything. The fairness and audit record is immutable to it: no UPDATE or DELETE on reward_tables,
 * rules, spins and inbound_events; spin_credits may only change `status` and `used_at`, and the
 * trigger refuses `used -> available`.
 */
const APP = 'engagement_app';
const TABLES = ['inbound_events', 'rules', 'reward_tables', 'spin_credits', 'spins'] as const;

export class IngestSchema1732200002000 implements MigrationInterface {
  name = 'IngestSchema1732200002000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "inbound_events" (
        "id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "source" text NOT NULL,
        "external_event_id" text NOT NULL,
        "external_player_hmac" text NOT NULL,
        "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
        "currency" text NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
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
        "id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "wheel_id" uuid NOT NULL,
        "source_event_id" uuid NOT NULL,
        "rule_id" text NOT NULL,
        "rule_version" integer NOT NULL,
        "seq" integer NOT NULL CHECK ("seq" >= 0),
        "status" text NOT NULL DEFAULT 'available' CHECK ("status" IN ('available', 'used')),
        "used_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("tenant_id", "source_event_id", "rule_id", "seq")
      )`);
    await q.query(
      `CREATE INDEX "spin_credits_available" ON "spin_credits" ("tenant_id", "user_id", "created_at", "id")
         WHERE "status" = 'available'`,
    );
    await q.query(`
      CREATE TABLE "spins" (
        "id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "credit_id" uuid NOT NULL REFERENCES "spin_credits" ("id"),
        "operation_id" text NOT NULL,
        "seed_version" integer NOT NULL,
        "table_version" integer NOT NULL,
        "hmac" text NOT NULL,
        "segment_index" integer NOT NULL CHECK ("segment_index" >= 0),
        "segment_label" text NOT NULL,
        "reward_coins" integer NOT NULL CHECK ("reward_coins" >= 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
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

    // The runtime role's privileges, all of them (a table not listed is unreachable for the app).
    const grants: string[] = [
      `GRANT SELECT, INSERT ON "inbound_events", "rules", "reward_tables", "spins" TO ${APP}`,
      `GRANT SELECT, INSERT ON "spin_credits" TO ${APP}`,
      `GRANT UPDATE ("status", "used_at") ON "spin_credits" TO ${APP}`,
      `GRANT SELECT, INSERT, UPDATE ON "tenant_projections" TO ${APP}`,
      `GRANT SELECT, INSERT ON "inbox" TO ${APP}`,
      `GRANT SELECT, INSERT, UPDATE ON "outbox" TO ${APP}`,
    ];
    for (const sql of grants) await q.query(sql);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of ['tenant_projections', 'inbox', 'outbox', ...TABLES]) {
      await q.query(`REVOKE ALL ON "${t}" FROM ${APP}`);
    }
    await q.query(`DROP TRIGGER spin_credits_no_reopen ON "spin_credits"`);
    await q.query(`DROP FUNCTION spin_credits_no_reopen()`);
    for (const t of [...TABLES].reverse()) {
      await disableTenantRls(q, t);
      await q.query(`DROP TABLE "${t}"`);
    }
  }
}
