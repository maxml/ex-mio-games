import type { Client } from 'pg';
import { uuidv7 } from '@ex-mio/contracts';
import { connectAs, inTenant } from '../testing/pg';

// Choke point: the database schema (migration `Ledger`), reached through the runtime role
// `payments_app` with raw SQL, so no application code can be what makes these pass.
// Every test names the mutation that must turn it red. Spec: docs/specs/payments.md, section 4.

let app: Client;
let admin: Client;
beforeAll(async () => {
  app = await connectAs('payments_app');
  admin = await connectAs('postgres');
});
afterAll(async () => {
  await app.end();
  await admin.end();
});

interface Seed {
  tenant: string;
  wallet: string;
  issuance: string;
  available: string;
  held: string;
  redeemed: string;
}

async function seed(): Promise<Seed> {
  const s: Seed = {
    tenant: uuidv7(),
    wallet: uuidv7(),
    issuance: uuidv7(),
    available: uuidv7(),
    held: uuidv7(),
    redeemed: uuidv7(),
  };
  await inTenant(app, s.tenant, async () => {
    await app.query(`INSERT INTO wallets (tenant_id, id) VALUES ($1, $2)`, [s.tenant, s.wallet]);
    const acc = (id: string, kind: string, wallet: string | null) =>
      app.query(
        `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency) VALUES ($1, $2, $3, $4, 'COIN')`,
        [s.tenant, id, kind, wallet],
      );
    await acc(s.issuance, 'tenant_issuance', null);
    await acc(s.available, 'player_available', s.wallet);
    await acc(s.held, 'player_held', s.wallet);
    await acc(s.redeemed, 'tenant_redeemed', null);
    for (const id of [s.issuance, s.available, s.held, s.redeemed]) {
      await app.query(`INSERT INTO balances (tenant_id, account_id, amount) VALUES ($1, $2, 0)`, [
        s.tenant,
        id,
      ]);
    }
  });
  return s;
}

interface Leg {
  account: string;
  direction: 'debit' | 'credit';
  amount: number;
  currency?: string;
}

/** Insert one journal transaction with its legs and COMMIT; the deferred trigger runs at commit. */
async function post(
  s: Seed,
  legs: Leg[],
  opts: { opType?: string; opId?: string; currency?: string } = {},
): Promise<string> {
  const txId = uuidv7();
  await inTenant(app, s.tenant, async () => {
    await app.query(
      `INSERT INTO journal_transactions
         (tenant_id, id, operation_type, operation_id, currency, created_by)
       VALUES ($1, $2, $3, $4, $5, 'test')`,
      [s.tenant, txId, opts.opType ?? 'spin_award', opts.opId ?? uuidv7(), opts.currency ?? 'COIN'],
    );
    for (const leg of legs) {
      await app.query(
        `INSERT INTO ledger_entries
           (tenant_id, id, transaction_id, account_id, direction, amount, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.tenant, uuidv7(), txId, leg.account, leg.direction, leg.amount, leg.currency ?? 'COIN'],
      );
    }
  });
  return txId;
}

const balanced = (s: Seed, amount = 5): Leg[] => [
  { account: s.issuance, direction: 'debit', amount },
  { account: s.available, direction: 'credit', amount },
];

describe('INV-L1 balanced legs are enforced by the database at commit', () => {
  // Mutation: drop the deferred constraint trigger `journal_balanced` -> the three rejections go red.
  it('accepts a balanced two-leg transaction (control: the guard is not simply rejecting everything)', async () => {
    const s = await seed();
    await expect(post(s, balanced(s))).resolves.toEqual(expect.any(String));
  });

  it('rejects a transaction with a single leg', async () => {
    const s = await seed();
    await expect(
      post(s, [{ account: s.available, direction: 'credit', amount: 5 }]),
    ).rejects.toThrow(/balanced|legs/i);
  });

  it('rejects a transaction whose debits and credits differ', async () => {
    const s = await seed();
    await expect(
      post(s, [
        { account: s.issuance, direction: 'debit', amount: 5 },
        { account: s.available, direction: 'credit', amount: 6 },
      ]),
    ).rejects.toThrow(/balanced|debit/i);
  });

  it('rejects a leg whose currency differs from its transaction', async () => {
    const s = await seed();
    await expect(
      post(s, [
        { account: s.issuance, direction: 'debit', amount: 5 },
        { account: s.available, direction: 'credit', amount: 5, currency: 'EUR' },
      ]),
    ).rejects.toThrow();
  });

  it('rejects a transaction with no legs at all', async () => {
    const s = await seed();
    await expect(post(s, [])).rejects.toThrow(/balanced|legs/i);
  });
});

describe('INV-L2 the journal is append-only for the runtime role', () => {
  // Mutation: GRANT UPDATE, DELETE on journal_transactions or ledger_entries to payments_app.
  it.each(['journal_transactions', 'ledger_entries'])(
    'payments_app cannot UPDATE or DELETE %s',
    async (table) => {
      const s = await seed();
      await post(s, balanced(s));
      const attempt = async (sql: string): Promise<string> => {
        try {
          await inTenant(app, s.tenant, () => app.query(sql));
          return 'no error';
        } catch (err) {
          return (err as Error).message;
        }
      };
      expect(await attempt(`UPDATE ${table} SET tenant_id = tenant_id`)).toMatch(
        /permission denied/i,
      );
      expect(await attempt(`DELETE FROM ${table}`)).toMatch(/permission denied/i);
      // Assert from the superuser connection that nothing changed.
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [s.tenant],
      );
      expect(rows[0].n).toBeGreaterThan(0);
    },
  );

  // Mutation: make payments_app the owner of the ledger tables, or a superuser.
  it('payments_app is not a superuser, does not bypass RLS and owns none of the ledger tables', async () => {
    const role = await app.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await app.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tableowner = current_user`,
    );
    expect(owned.rows).toEqual([]);
  });
});

describe('INV-L3 one business operation has at most one journal transaction', () => {
  // Mutation: drop UNIQUE (tenant_id, operation_type, operation_id) on journal_transactions.
  it('a second transaction with the same (type, operation_id) violates the unique constraint', async () => {
    const s = await seed();
    const opId = uuidv7();
    await post(s, balanced(s), { opType: 'spin_award', opId });
    await expect(post(s, balanced(s), { opType: 'spin_award', opId })).rejects.toThrow(
      /unique|duplicate/i,
    );
  });

  it('the same operation_id under another operation type is a different operation', async () => {
    const s = await seed();
    const opId = uuidv7();
    await post(s, balanced(s), { opType: 'spin_award', opId });
    await expect(
      post(
        s,
        [
          { account: s.available, direction: 'debit', amount: 1 },
          { account: s.held, direction: 'credit', amount: 1 },
        ],
        { opType: 'reserve', opId },
      ),
    ).resolves.toEqual(expect.any(String));
  });
});

describe('INV-L4 a balance cannot go below zero', () => {
  // Mutation: drop CHECK (amount >= 0) on balances.
  it('rejects a write that would make a balance negative', async () => {
    const s = await seed();
    await expect(
      inTenant(app, s.tenant, () =>
        app.query(
          `UPDATE balances SET amount = amount - 1 WHERE tenant_id = $1 AND account_id = $2`,
          [s.tenant, s.available],
        ),
      ),
    ).rejects.toThrow(/check|negative|violates/i);
  });
});

describe('INV-L5 amounts are positive integers within the cap, and never floats', () => {
  // Mutation: drop CHECK (amount > 0 AND amount <= 1000000000000) on ledger_entries.
  it.each([0, -1, 1_000_000_000_001])('rejects a leg of %p', async (amount) => {
    const s = await seed();
    await expect(
      post(s, [
        { account: s.issuance, direction: 'debit', amount },
        { account: s.available, direction: 'credit', amount },
      ]),
    ).rejects.toThrow(/check|violates|range/i);
  });

  // Mutation: change any coin amount column to numeric(…, 2), real or double precision.
  it('every coin amount column is an integer type', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, column_name, data_type, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name = 'amount' OR column_name LIKE '%\\_minor' OR column_name = 'quantity')
          AND table_name IN ('ledger_entries','balances','reserves','invoices','billing_plans','usage_meters')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(['bigint', 'integer']).toContain(r.data_type);
    }
  });
});

describe('INV-L6 ledger tables are tenant-isolated by RLS', () => {
  // Mutation: remove ENABLE/FORCE ROW LEVEL SECURITY (enableTenantRls) from any ledger table.
  it.each([
    'wallets',
    'accounts',
    'balances',
    'journal_transactions',
    'ledger_entries',
    'reserves',
  ])('tenant B and a tenant-less connection see nothing of tenant A in %s', async (table) => {
    const a = await seed();
    await post(a, balanced(a));
    const b = await seed();
    const count = (tenant: string | null) =>
      tenant
        ? inTenant(app, tenant, () =>
            app.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [a.tenant]),
          )
        : app.query(`SELECT count(*)::int AS n FROM ${table}`);
    expect((await count(b.tenant)).rows[0].n).toBe(0);
    expect((await count(null)).rows[0].n).toBe(0);
  });
});

describe('INV-O1 the identity link is erasable; the account id and the ledger stay', () => {
  // Mutation: add a user_id column to wallets/accounts, or make the link a FK that cascades.
  it('no ledger table other than the link carries a user id', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('user_id','owner_user_id','player_id','email')
          AND table_name IN ('wallets','accounts','balances','journal_transactions','ledger_entries','reserves')`,
    );
    expect(rows).toEqual([]);
  });

  // Mutation: revoke DELETE on wallet_owner_links from payments_app, or cascade it into the ledger.
  it('deleting the link leaves wallet, accounts, balances and entries untouched', async () => {
    const s = await seed();
    const user = uuidv7();
    await inTenant(app, s.tenant, () =>
      app.query(
        `INSERT INTO wallet_owner_links (tenant_id, wallet_id, user_id) VALUES ($1, $2, $3)`,
        [s.tenant, s.wallet, user],
      ),
    );
    await post(s, balanced(s, 9));
    await inTenant(app, s.tenant, () =>
      app.query(`DELETE FROM wallet_owner_links WHERE tenant_id = $1 AND user_id = $2`, [
        s.tenant,
        user,
      ]),
    );
    const after = await admin.query(
      `SELECT (SELECT count(*)::int FROM wallets WHERE tenant_id = $1) AS wallets,
              (SELECT count(*)::int FROM ledger_entries WHERE tenant_id = $1) AS entries,
              (SELECT count(*)::int FROM wallet_owner_links WHERE tenant_id = $1) AS links`,
      [s.tenant],
    );
    expect(after.rows[0]).toEqual({ wallets: 1, entries: 2, links: 0 });
  });
});
