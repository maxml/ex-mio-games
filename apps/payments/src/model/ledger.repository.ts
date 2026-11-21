import { Injectable } from '@nestjs/common';
import { COIN_CURRENCY, uuidv7, type ReserveState } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

export type AccountKind =
  | 'player_available'
  | 'player_held'
  | 'tenant_issuance'
  | 'tenant_redeemed';
export type OperationType = 'spin_award' | 'reserve' | 'capture' | 'release' | 'refund';
export type Direction = 'debit' | 'credit';

export interface WalletAccounts {
  walletId: string;
  available: string;
  held: string;
}

export interface SystemAccounts {
  issuance: string;
  redeemed: string;
}

export interface Leg {
  accountId: string;
  direction: Direction;
  amount: number;
}

export interface ReserveRow {
  walletId: string;
  amount: number;
  state: ReserveState;
}

export interface JournalRow {
  id: string;
}

type Row = Record<string, unknown>;

/**
 * UPDATE / DELETE through `EntityManager.query` return `[rows, affectedCount]` on Postgres; every
 * other statement returns the rows. This hides the difference.
 */
function rowsOf(raw: unknown, isModifying = false): Row[] {
  if (isModifying && Array.isArray(raw) && Array.isArray(raw[0])) return raw[0] as Row[];
  return raw as Row[];
}

/**
 * Data access of the ledger: wallets, accounts, balances, journal, reserves. Every statement is
 * parameterised and filters by `tenant_id` explicitly (row level security is the second line).
 * Balances are only ever changed by conditional RELATIVE updates (`applyDelta`); a decision is never
 * made from a value read earlier.
 */
@Injectable()
export class LedgerRepository {
  // ---- wallets and accounts -------------------------------------------------------------------

  async walletByPlayer(tx: Tx, tenantId: string, playerId: string): Promise<WalletAccounts | null> {
    const rows = rowsOf(
      await tx.query(
        `SELECT a.wallet_id, a.id, a.kind FROM wallet_owner_links l
           JOIN accounts a ON a.tenant_id = l.tenant_id AND a.wallet_id = l.wallet_id
          WHERE l.tenant_id = $1 AND l.user_id = $2`,
        [tenantId, playerId],
      ),
    );
    return toWallet(rows);
  }

  async walletById(tx: Tx, tenantId: string, walletId: string): Promise<WalletAccounts | null> {
    const rows = rowsOf(
      await tx.query(
        `SELECT a.wallet_id, a.id, a.kind FROM accounts a WHERE a.tenant_id = $1 AND a.wallet_id = $2`,
        [tenantId, walletId],
      ),
    );
    return toWallet(rows);
  }

  /** The player a wallet belongs to, or null once the identity link was erased. */
  async playerOfWallet(tx: Tx, tenantId: string, walletId: string): Promise<string | null> {
    const rows = rowsOf(
      await tx.query(
        `SELECT user_id FROM wallet_owner_links WHERE tenant_id = $1 AND wallet_id = $2`,
        [tenantId, walletId],
      ),
    );
    return (rows[0]?.user_id as string | undefined) ?? null;
  }

  async systemAccounts(tx: Tx, tenantId: string): Promise<Partial<SystemAccounts>> {
    const rows = rowsOf(
      await tx.query(`SELECT id, kind FROM accounts WHERE tenant_id = $1 AND wallet_id IS NULL`, [
        tenantId,
      ]),
    );
    const out: Partial<SystemAccounts> = {};
    for (const r of rows) {
      if (r.kind === 'tenant_issuance') out.issuance = r.id as string;
      if (r.kind === 'tenant_redeemed') out.redeemed = r.id as string;
    }
    return out;
  }

  /**
   * The tenant's two system accounts, created on first use with `INSERT ... ON CONFLICT DO NOTHING`
   * and a re-select, so parallel first credits end up with one account of each kind (F7).
   */
  async ensureSystemAccounts(tx: Tx, tenantId: string): Promise<SystemAccounts> {
    const have = await this.systemAccounts(tx, tenantId);
    if (have.issuance && have.redeemed) return have as SystemAccounts;
    for (const kind of ['tenant_issuance', 'tenant_redeemed'] as const) {
      const id = uuidv7();
      const inserted = rowsOf(
        await tx.query(
          `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency)
           VALUES ($1, $2, $3, NULL, $4) ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId, id, kind, COIN_CURRENCY],
        ),
      );
      if (inserted.length > 0) await this.insertBalance(tx, tenantId, id);
    }
    const now = await this.systemAccounts(tx, tenantId);
    if (!now.issuance || !now.redeemed) throw new Error('tenant system accounts are missing');
    return now as SystemAccounts;
  }

  /**
   * The wallet of a player, created with its two accounts on first use. The link row is the gate:
   * `ON CONFLICT (tenant_id, user_id) DO NOTHING` lets exactly one parallel caller create it.
   */
  async ensureWallet(tx: Tx, tenantId: string, playerId: string): Promise<WalletAccounts> {
    const found = await this.walletByPlayer(tx, tenantId, playerId);
    if (found) return found;
    const walletId = uuidv7();
    const claimed = rowsOf(
      await tx.query(
        `INSERT INTO wallet_owner_links (tenant_id, wallet_id, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING wallet_id`,
        [tenantId, walletId, playerId],
      ),
    );
    if (claimed.length === 0) {
      const winner = await this.walletByPlayer(tx, tenantId, playerId);
      if (!winner) throw new Error('wallet link vanished after a conflict');
      return winner;
    }
    await tx.query(`INSERT INTO wallets (tenant_id, id) VALUES ($1, $2)`, [tenantId, walletId]);
    const accounts: WalletAccounts = { walletId, available: uuidv7(), held: uuidv7() };
    for (const [id, kind] of [
      [accounts.available, 'player_available'],
      [accounts.held, 'player_held'],
    ] as const) {
      await tx.query(
        `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, id, kind, walletId, COIN_CURRENCY],
      );
      await this.insertBalance(tx, tenantId, id);
    }
    // The scheduled reconciliation lists tenants from this id-only registry (no BYPASSRLS needed).
    await tx.query(
      `INSERT INTO reconciliation_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [tenantId],
    );
    return accounts;
  }

  private async insertBalance(tx: Tx, tenantId: string, accountId: string): Promise<void> {
    await tx.query(`INSERT INTO balances (tenant_id, account_id, amount) VALUES ($1, $2, 0)`, [
      tenantId,
      accountId,
    ]);
  }

  /** Erasure: removes the only link between a person and a wallet. The wallet and the ledger stay. */
  async deleteLink(tx: Tx, tenantId: string, playerId: string): Promise<void> {
    await tx.query(`DELETE FROM wallet_owner_links WHERE tenant_id = $1 AND user_id = $2`, [
      tenantId,
      playerId,
    ]);
  }

  // ---- balances -------------------------------------------------------------------------------

  /**
   * Add `delta` to an account balance with ONE conditional relative UPDATE. A negative delta only
   * applies when `amount >= |delta|`. Returns the new amount, or null when the guard refused it.
   */
  async applyDelta(
    tx: Tx,
    tenantId: string,
    accountId: string,
    delta: number,
  ): Promise<number | null> {
    if (delta >= 0) {
      const rows = rowsOf(
        await tx.query(
          `UPDATE balances SET amount = amount + $1 WHERE tenant_id = $2 AND account_id = $3 RETURNING amount`,
          [delta, tenantId, accountId],
        ),
        true,
      );
      return rows[0] ? Number(rows[0].amount) : null;
    }
    const rows = rowsOf(
      await tx.query(
        `UPDATE balances SET amount = amount - $1 WHERE tenant_id = $2 AND account_id = $3 AND amount >= $1 RETURNING amount`,
        [-delta, tenantId, accountId],
      ),
      true,
    );
    return rows[0] ? Number(rows[0].amount) : null;
  }

  /** Current available and held of a wallet, read AFTER the writes of the same transaction. */
  async walletBalance(
    tx: Tx,
    tenantId: string,
    walletId: string,
  ): Promise<{ available: number; held: number }> {
    const rows = rowsOf(
      await tx.query(
        `SELECT a.kind, b.amount FROM accounts a JOIN balances b ON b.tenant_id = a.tenant_id AND b.account_id = a.id
          WHERE a.tenant_id = $1 AND a.wallet_id = $2`,
        [tenantId, walletId],
      ),
    );
    const of = (kind: AccountKind) => Number(rows.find((r) => r.kind === kind)?.amount ?? 0);
    return { available: of('player_available'), held: of('player_held') };
  }

  // ---- journal --------------------------------------------------------------------------------

  /**
   * Insert the journal row of a business operation. Returns false when the operation already has a
   * transaction (unique `(tenant_id, operation_type, operation_id)`); the insert waits for a parallel
   * one to finish first, so a false is always about a committed transaction.
   */
  async insertJournal(
    tx: Tx,
    row: {
      tenantId: string;
      id: string;
      type: OperationType;
      operationId: string;
      createdBy: string;
    },
  ): Promise<boolean> {
    const inserted = rowsOf(
      await tx.query(
        `INSERT INTO journal_transactions (tenant_id, id, operation_type, operation_id, currency, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, operation_type, operation_id) DO NOTHING RETURNING id`,
        [row.tenantId, row.id, row.type, row.operationId, COIN_CURRENCY, row.createdBy],
      ),
    );
    return inserted.length > 0;
  }

  async journalByOperation(
    tx: Tx,
    tenantId: string,
    type: OperationType,
    operationId: string,
  ): Promise<JournalRow | null> {
    const rows = rowsOf(
      await tx.query(
        `SELECT id FROM journal_transactions WHERE tenant_id = $1 AND operation_type = $2 AND operation_id = $3`,
        [tenantId, type, operationId],
      ),
    );
    return rows[0] ? { id: rows[0].id as string } : null;
  }

  async insertLegs(tx: Tx, tenantId: string, transactionId: string, legs: Leg[]): Promise<void> {
    for (const leg of legs) {
      await tx.query(
        `INSERT INTO ledger_entries (tenant_id, id, transaction_id, account_id, direction, amount, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          uuidv7(),
          transactionId,
          leg.accountId,
          leg.direction,
          leg.amount,
          COIN_CURRENCY,
        ],
      );
    }
  }

  /** What a stored spin award says: the credited amount and the wallet it went to. */
  async awardOf(
    tx: Tx,
    tenantId: string,
    transactionId: string,
  ): Promise<{ amount: number; walletId: string | null; playerId: string | null } | null> {
    const rows = rowsOf(
      await tx.query(
        `SELECT e.amount, a.wallet_id, l.user_id FROM ledger_entries e
           JOIN accounts a ON a.tenant_id = e.tenant_id AND a.id = e.account_id
           LEFT JOIN wallet_owner_links l ON l.tenant_id = a.tenant_id AND l.wallet_id = a.wallet_id
          WHERE e.tenant_id = $1 AND e.transaction_id = $2 AND e.direction = 'credit'`,
        [tenantId, transactionId],
      ),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      amount: Number(r.amount),
      walletId: (r.wallet_id as string | null) ?? null,
      playerId: (r.user_id as string | null) ?? null,
    };
  }

  // ---- reserves -------------------------------------------------------------------------------

  async reserveById(tx: Tx, tenantId: string, reserveId: string): Promise<ReserveRow | null> {
    const rows = rowsOf(
      await tx.query(
        `SELECT wallet_id, amount, state FROM reserves WHERE tenant_id = $1 AND id = $2`,
        [tenantId, reserveId],
      ),
    );
    return rows[0] ? toReserve(rows[0]) : null;
  }

  async insertReserve(
    tx: Tx,
    row: { tenantId: string; id: string; walletId: string; amount: number },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO reserves (tenant_id, id, wallet_id, amount, state) VALUES ($1, $2, $3, $4, 'reserved')`,
      [row.tenantId, row.id, row.walletId, row.amount],
    );
  }

  /**
   * Move a reserve from `from` to `to` with one conditional UPDATE. Returns the reserve when this call
   * made the transition, null when the state was not `from` (decided by the database, not by a read).
   */
  async transitionReserve(
    tx: Tx,
    tenantId: string,
    reserveId: string,
    from: ReserveState,
    to: ReserveState,
  ): Promise<{ walletId: string; amount: number } | null> {
    const rows = rowsOf(
      await tx.query(
        `UPDATE reserves SET state = $1, state_changed_at = now()
          WHERE tenant_id = $2 AND id = $3 AND state = $4 RETURNING wallet_id, amount`,
        [to, tenantId, reserveId, from],
      ),
      true,
    );
    return rows[0]
      ? { walletId: rows[0].wallet_id as string, amount: Number(rows[0].amount) }
      : null;
  }
}

function toWallet(rows: Row[]): WalletAccounts | null {
  if (rows.length === 0) return null;
  const walletId = rows[0]!.wallet_id as string;
  const available = rows.find((r) => r.kind === 'player_available')?.id as string | undefined;
  const held = rows.find((r) => r.kind === 'player_held')?.id as string | undefined;
  if (!available || !held) throw new Error('wallet accounts are incomplete');
  return { walletId, available, held };
}

function toReserve(r: Row): ReserveRow {
  return {
    walletId: r.wallet_id as string,
    amount: Number(r.amount),
    state: r.state as ReserveState,
  };
}
