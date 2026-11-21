import type { MigrationInterface, QueryRunner } from 'typeorm';
import { disableTenantRls, enableTenantRls } from '@ex-mio/tenancy';

/**
 * The payments ledger, usage metering and billing schema. The grants of the runtime role
 * `payments_app` are NOT here: they are one map (`PAYMENTS_APP_GRANTS`) applied by the
 * `AppRoleGrants` migration that runs after this one (foundation owner/app split).
 * This migration runs as the owner role `payments_owner`; the runtime role owns nothing.
 *
 * Every tenant table is ENABLE + FORCE row level security with one policy (enableTenantRls). The
 * tenant-less tables are: billing_plans, outbox, inbox, migrations, reconciliation_tenants.
 */

const TENANT_TABLES = [
  'wallets',
  'wallet_owner_links',
  'accounts',
  'balances',
  'journal_transactions',
  'ledger_entries',
  'reserves',
  'reconciliation_runs',
  'usage_events',
  'usage_meters',
  'usage_players',
  'usage_reports',
  'subscriptions',
  'invoices',
  'payment_attempts',
  'billing_webhook_events',
] as const;

/** Deferred constraint trigger body: balanced legs, currency, sealed transactions (spec section 4). */
const JOURNAL_BALANCED_FN = `
CREATE FUNCTION journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  tx_id uuid;
  tx_currency text;
  tx_xmin xid;
  legs integer;
  debits bigint;
  credits bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    tx_id := NEW.transaction_id;
  ELSE
    tx_id := NEW.id;
  END IF;

  SELECT currency, xmin INTO tx_currency, tx_xmin
    FROM journal_transactions WHERE tenant_id = NEW.tenant_id AND id = tx_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal transaction % does not exist', tx_id;
  END IF;

  -- A leg may only be added by the transaction that created the journal row.
  IF TG_TABLE_NAME = 'ledger_entries' AND NOT (tx_xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'journal transaction % is sealed: legs cannot be added after commit', tx_id;
  END IF;

  SELECT count(*),
         coalesce(sum(amount) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO legs, debits, credits
    FROM ledger_entries WHERE tenant_id = NEW.tenant_id AND transaction_id = tx_id;

  IF legs < 2 THEN
    RAISE EXCEPTION 'journal transaction % has fewer than 2 legs', tx_id;
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'journal transaction % is not balanced (debits %, credits %)', tx_id, debits, credits;
  END IF;
  IF EXISTS (
    SELECT 1 FROM ledger_entries e JOIN accounts a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
     WHERE e.tenant_id = NEW.tenant_id AND e.transaction_id = tx_id
       AND (e.currency <> tx_currency OR a.currency <> tx_currency)
  ) THEN
    RAISE EXCEPTION 'journal transaction % has a currency mismatch', tx_id;
  END IF;
  RETURN NULL;
END
$fn$`;

export class Ledger1732300000000 implements MigrationInterface {
  name = 'Ledger1732300000000';

  async up(q: QueryRunner): Promise<void> {
    // The foundation's single-table credit store is replaced by the double-entry ledger.
    await disableTenantRls(q, 'coin_credits');
    await q.query(`DROP TABLE "coin_credits"`);

    // ---- ledger ---------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "wallets" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "sandbox" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id")
      )`);
    // The only table that ties a wallet to a person. Deleting a row is the erasure (MIO-107).
    // A player has one wallet per environment (X-2): the link carries the wallet's `sandbox` flag.
    await q.query(`
      CREATE TABLE "wallet_owner_links" (
        "tenant_id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "sandbox" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "wallet_id"),
        UNIQUE ("tenant_id", "user_id", "sandbox"),
        FOREIGN KEY ("tenant_id", "wallet_id") REFERENCES "wallets" ("tenant_id", "id")
          DEFERRABLE INITIALLY DEFERRED
      )`);
    await q.query(`
      CREATE TABLE "accounts" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "kind" text NOT NULL
          CHECK ("kind" IN ('player_available', 'player_held', 'tenant_issuance', 'tenant_redeemed')),
        "wallet_id" uuid,
        "currency" text NOT NULL,
        "sandbox" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        CHECK (("kind" IN ('player_available', 'player_held')) = ("wallet_id" IS NOT NULL)),
        FOREIGN KEY ("tenant_id", "wallet_id") REFERENCES "wallets" ("tenant_id", "id")
          DEFERRABLE INITIALLY DEFERRED
      )`);
    // One issuance and one redeemed account per tenant AND environment: sandbox coins are issued
    // from, and counted against, their own system accounts (X-2).
    await q.query(
      `CREATE UNIQUE INDEX "accounts_tenant_kind" ON "accounts" ("tenant_id", "kind", "sandbox") WHERE "wallet_id" IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "accounts_wallet_kind" ON "accounts" ("tenant_id", "wallet_id", "kind") WHERE "wallet_id" IS NOT NULL`,
    );
    await q.query(`
      CREATE TABLE "balances" (
        "tenant_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "amount" bigint NOT NULL DEFAULT 0 CHECK ("amount" >= 0),
        PRIMARY KEY ("tenant_id", "account_id"),
        FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id")
      )`);
    await q.query(`
      CREATE TABLE "journal_transactions" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "operation_type" text NOT NULL
          CHECK ("operation_type" IN ('spin_award', 'reserve', 'capture', 'release', 'refund')),
        "operation_id" uuid NOT NULL,
        "currency" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" text NOT NULL,
        PRIMARY KEY ("tenant_id", "id"),
        UNIQUE ("tenant_id", "operation_type", "operation_id")
      )`);
    await q.query(`
      CREATE TABLE "ledger_entries" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "transaction_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "direction" text NOT NULL CHECK ("direction" IN ('debit', 'credit')),
        "amount" bigint NOT NULL CHECK ("amount" > 0 AND "amount" <= 1000000000000),
        "currency" text NOT NULL,
        PRIMARY KEY ("tenant_id", "id"),
        FOREIGN KEY ("tenant_id", "transaction_id") REFERENCES "journal_transactions" ("tenant_id", "id")
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE INDEX "ledger_entries_transaction" ON "ledger_entries" ("tenant_id", "transaction_id")`,
    );
    await q.query(
      `CREATE INDEX "ledger_entries_account" ON "ledger_entries" ("tenant_id", "account_id")`,
    );
    await q.query(`
      CREATE TABLE "reserves" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "amount" bigint NOT NULL CHECK ("amount" > 0 AND "amount" <= 1000000000000),
        "state" text NOT NULL CHECK ("state" IN ('reserved', 'captured', 'released', 'refunded')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "state_changed_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        FOREIGN KEY ("tenant_id", "wallet_id") REFERENCES "wallets" ("tenant_id", "id")
          DEFERRABLE INITIALLY DEFERRED
      )`);

    await q.query(JOURNAL_BALANCED_FN);
    for (const table of ['journal_transactions', 'ledger_entries']) {
      await q.query(`
        CREATE CONSTRAINT TRIGGER "journal_balanced" AFTER INSERT ON "${table}"
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced()`);
    }

    // ---- reconciliation -------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "reconciliation_runs" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "status" text NOT NULL CHECK ("status" IN ('ok', 'mismatch', 'failed')),
        "started_at" timestamptz NOT NULL,
        "finished_at" timestamptz,
        "accounts_checked" integer NOT NULL DEFAULT 0,
        "mismatches" jsonb NOT NULL DEFAULT '[]',
        "report" jsonb,
        PRIMARY KEY ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE INDEX "reconciliation_runs_started" ON "reconciliation_runs" ("tenant_id", "started_at" DESC)`,
    );
    // An id-only registry, so the scheduled job can list tenants without BYPASSRLS.
    await q.query(`CREATE TABLE "reconciliation_tenants" ("tenant_id" uuid PRIMARY KEY)`);

    // ---- usage metering -------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "usage_events" (
        "tenant_id" uuid NOT NULL,
        "spin_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "counted_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "spin_id")
      )`);
    await q.query(`
      CREATE TABLE "usage_meters" (
        "tenant_id" uuid NOT NULL,
        "period" text NOT NULL CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
        "metric" text NOT NULL CHECK ("metric" IN ('spins')),
        "quantity" bigint NOT NULL DEFAULT 0 CHECK ("quantity" >= 0),
        PRIMARY KEY ("tenant_id", "period", "metric")
      )`);
    // MAU is keyed by a salted hash of the player id, never the id itself (erasure, F19).
    await q.query(`
      CREATE TABLE "usage_players" (
        "tenant_id" uuid NOT NULL,
        "period" text NOT NULL CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
        "player_key" text NOT NULL,
        PRIMARY KEY ("tenant_id", "period", "player_key")
      )`);
    await q.query(`
      CREATE TABLE "usage_reports" (
        "tenant_id" uuid NOT NULL,
        "period" text NOT NULL CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
        "quantity" bigint NOT NULL CHECK ("quantity" >= 0),
        "idempotency_key" text NOT NULL,
        "reported_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "period")
      )`);

    // ---- billing --------------------------------------------------------------------------
    await q.query(`
      CREATE TABLE "billing_plans" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" text NOT NULL UNIQUE,
        "name" text NOT NULL,
        "interval" text NOT NULL DEFAULT 'month' CHECK ("interval" = 'month'),
        "price_minor" integer NOT NULL CHECK ("price_minor" >= 0),
        "currency" text NOT NULL CHECK (char_length("currency") = 3)
      )`);
    // The one tariff map (MIO-091). Prices are integer cents.
    await q.query(`
      INSERT INTO "billing_plans" ("code", "name", "price_minor", "currency") VALUES
        ('free', 'Free', 0, 'USD'),
        ('pro', 'Pro', 4900, 'USD'),
        ('scale', 'Scale', 19900, 'USD')`);
    await q.query(`
      CREATE TABLE "subscriptions" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "plan_id" uuid NOT NULL REFERENCES "billing_plans" ("id"),
        "status" text NOT NULL
          CHECK ("status" IN ('pending', 'active', 'past_due', 'declined', 'canceled')),
        "provider" text NOT NULL,
        "provider_subscription_id" text NOT NULL,
        "provider_customer_id" text NOT NULL,
        "provider_version" integer NOT NULL DEFAULT 0 CHECK ("provider_version" >= 0),
        "current_period_start" timestamptz NOT NULL,
        "current_period_end" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        UNIQUE ("tenant_id", "provider", "provider_subscription_id")
      )`);
    await q.query(`
      CREATE TABLE "invoices" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "subscription_id" uuid NOT NULL,
        "amount_minor" integer NOT NULL CHECK ("amount_minor" >= 0),
        "currency" text NOT NULL CHECK (char_length("currency") = 3),
        "status" text NOT NULL CHECK ("status" IN ('paid', 'failed')),
        "period_start" timestamptz NOT NULL,
        "period_end" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        FOREIGN KEY ("tenant_id", "subscription_id") REFERENCES "subscriptions" ("tenant_id", "id")
      )`);
    // One paid invoice per subscription period, even if the provider re-sends it under a new event id.
    await q.query(
      `CREATE UNIQUE INDEX "invoices_paid_period" ON "invoices" ("tenant_id", "subscription_id", "period_start") WHERE "status" = 'paid'`,
    );
    // No card number column: only the last four digits and the brand (F20).
    await q.query(`
      CREATE TABLE "payment_attempts" (
        "tenant_id" uuid NOT NULL,
        "id" uuid NOT NULL,
        "plan_id" uuid NOT NULL REFERENCES "billing_plans" ("id"),
        "subscription_id" uuid,
        "state" text NOT NULL CHECK ("state" IN ('processing', 'succeeded', 'declined', 'cancelled')),
        "card_last4" text NOT NULL CHECK ("card_last4" ~ '^[0-9]{4}$'),
        "card_brand" text NOT NULL CHECK ("card_brand" IN ('visa', 'mastercard')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "id"),
        FOREIGN KEY ("tenant_id", "subscription_id") REFERENCES "subscriptions" ("tenant_id", "id")
      )`);
    await q.query(
      `CREATE INDEX "payment_attempts_subscription" ON "payment_attempts" ("tenant_id", "subscription_id")`,
    );
    await q.query(`
      CREATE TABLE "billing_webhook_events" (
        "tenant_id" uuid NOT NULL,
        "provider" text NOT NULL,
        "event_id" text NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "provider", "event_id")
      )`);

    for (const table of TENANT_TABLES) await enableTenantRls(q, table);
    // Grants of the runtime role: see the AppRoleGrants migration (PAYMENTS_APP_GRANTS).
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of [...TENANT_TABLES].reverse()) await disableTenantRls(q, table);
    for (const table of [
      'billing_webhook_events',
      'payment_attempts',
      'invoices',
      'subscriptions',
      'billing_plans',
      'usage_reports',
      'usage_players',
      'usage_meters',
      'usage_events',
      'reconciliation_tenants',
      'reconciliation_runs',
      'reserves',
      'ledger_entries',
      'journal_transactions',
      'balances',
      'accounts',
      'wallet_owner_links',
      'wallets',
    ]) {
      await q.query(`DROP TABLE "${table}" CASCADE`);
    }
    await q.query(`DROP FUNCTION journal_balanced()`);
    await q.query(`
      CREATE TABLE "coin_credits" (
        "id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "amount" integer NOT NULL CHECK ("amount" > 0),
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`);
    await enableTenantRls(q, 'coin_credits');
  }
}
