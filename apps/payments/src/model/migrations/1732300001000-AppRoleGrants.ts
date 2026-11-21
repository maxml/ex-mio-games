import type { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleName, grantAppRole, revokeAppRole, type AppGrants } from '@ex-mio/service-kit';

/**
 * The runtime role's privileges, all of them, in one place (the foundation owner/app split).
 * `payments_app` is not the owner of these tables: it cannot ALTER them, DROP them or switch
 * row-level security off. A table that is not listed here is not reachable by the app.
 * It runs after the `Ledger` migration, which creates the tables. Tests pin this list against
 * the live database (`ledger.schema.pgtest.ts`, `tests/compose` roles).
 */
export const PAYMENTS_APP_GRANTS: AppGrants = {
  accounts: ['SELECT', 'INSERT'],
  balances: ['SELECT', 'INSERT'], // UPDATE is column-level, see PAYMENTS_APP_COLUMN_UPDATES
  billing_plans: ['SELECT'],
  billing_webhook_events: ['SELECT', 'INSERT'],
  idempotency_keys: ['SELECT', 'INSERT'],
  inbox: ['SELECT', 'INSERT'],
  invoices: ['SELECT', 'INSERT'],
  journal_transactions: ['SELECT', 'INSERT'],
  ledger_entries: ['SELECT', 'INSERT'],
  outbox: ['SELECT', 'INSERT', 'UPDATE'], // the relay marks rows published, parked or retried
  payment_attempts: ['SELECT', 'INSERT', 'UPDATE'],
  reconciliation_runs: ['SELECT', 'INSERT'],
  reconciliation_tenants: ['SELECT', 'INSERT'],
  reserves: ['SELECT', 'INSERT'], // UPDATE is column-level
  subscriptions: ['SELECT', 'INSERT', 'UPDATE'],
  usage_events: ['SELECT', 'INSERT'],
  usage_meters: ['SELECT', 'INSERT', 'UPDATE'],
  usage_players: ['SELECT', 'INSERT'],
  usage_reports: ['SELECT', 'INSERT'],
  wallet_owner_links: ['SELECT', 'INSERT', 'DELETE'],
  wallets: ['SELECT', 'INSERT'],
};

/**
 * Column-level UPDATE: the map above cannot express it. A balance changes only its amount and a
 * reserve only its state, so no code path (or SQL injection) can rewrite an owner or a journal.
 */
export const PAYMENTS_APP_COLUMN_UPDATES: Readonly<Record<string, readonly string[]>> = {
  balances: ['amount'],
  reserves: ['state', 'state_changed_at'],
};

export class AppRoleGrants1732300001000 implements MigrationInterface {
  name = 'AppRoleGrants1732300001000';

  async up(q: QueryRunner): Promise<void> {
    const role = appRoleName('payments');
    await grantAppRole(q, role, PAYMENTS_APP_GRANTS);
    for (const [table, columns] of Object.entries(PAYMENTS_APP_COLUMN_UPDATES)) {
      const list = columns.map((c) => `"${c}"`).join(', ');
      await q.query(`GRANT UPDATE (${list}) ON "${table}" TO "${role}"`);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    await revokeAppRole(q, appRoleName('payments'), PAYMENTS_APP_GRANTS);
  }
}
