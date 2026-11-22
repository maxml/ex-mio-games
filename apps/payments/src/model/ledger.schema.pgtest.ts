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
    await app.query(`INSERT INTO wallets (tenant_id, id, sandbox) VALUES ($1, $2, false)`, [
      s.tenant,
      s.wallet,
    ]);
    const acc = (id: string, kind: string, wallet: string | null) =>
      app.query(
        `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency, sandbox) VALUES ($1, $2, $3, $4, 'COIN', false)`,
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
    // A link and a reserve, so the isolation tests below have a row to hide in every table (F15).
    await app.query(
      `INSERT INTO wallet_owner_links (tenant_id, wallet_id, user_id, sandbox) VALUES ($1, $2, $3, false)`,
      [s.tenant, s.wallet, uuidv7()],
    );
    await app.query(
      `INSERT INTO reserves (tenant_id, id, wallet_id, amount, state) VALUES ($1, $2, $3, 1, 'reserved')`,
      [s.tenant, uuidv7(), s.wallet],
    );
  });
  return s;
}

/** Try `sql` as the runtime role in a tenant transaction; resolves to the error message or 'no error'. */
async function attempt(tenant: string, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await inTenant(app, tenant, () => app.query(sql, params));
    return 'no error';
  } catch (err) {
    return (err as Error).message;
  }
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
    ).rejects.toThrow(/fewer than 2 legs/i);
  });

  it('rejects a transaction whose debits and credits differ', async () => {
    const s = await seed();
    await expect(
      post(s, [
        { account: s.issuance, direction: 'debit', amount: 5 },
        { account: s.available, direction: 'credit', amount: 6 },
      ]),
    ).rejects.toThrow(/not balanced/i);
  });

  // The message is pinned: a bare CHECK (currency = 'COIN') would also reject, with another text,
  // and would leave the trigger droppable unseen (F16).
  it('rejects a leg whose currency differs from its transaction, by the trigger', async () => {
    const s = await seed();
    await expect(
      post(s, [
        { account: s.issuance, direction: 'debit', amount: 5 },
        { account: s.available, direction: 'credit', amount: 5, currency: 'EUR' },
      ]),
    ).rejects.toThrow(/currency mismatch/i);
  });

  it('rejects a COIN transaction that posts to an account of another currency', async () => {
    const s = await seed();
    const eur = uuidv7();
    const otherWallet = uuidv7();
    await inTenant(app, s.tenant, async () => {
      await app.query(`INSERT INTO wallets (tenant_id, id, sandbox) VALUES ($1, $2, false)`, [
        s.tenant,
        otherWallet,
      ]);
      await app.query(
        `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency, sandbox) VALUES ($1, $2, 'player_available', $3, 'EUR', false)`,
        [s.tenant, eur, otherWallet],
      );
    });
    await expect(
      post(s, [
        { account: s.issuance, direction: 'debit', amount: 5 },
        { account: eur, direction: 'credit', amount: 5 },
      ]),
    ).rejects.toThrow(/currency mismatch/i);
  });

  it('rejects a transaction with no legs at all', async () => {
    const s = await seed();
    await expect(post(s, [])).rejects.toThrow(/fewer than 2 legs/i);
  });

  // History must not be rewritten by adding balanced legs to an already committed transaction.
  // Mutation: let the trigger judge only the legs inserted in the current transaction.
  it('rejects legs added to a transaction that was already committed', async () => {
    const s = await seed();
    const txId = await post(s, balanced(s));
    const late = inTenant(app, s.tenant, async () => {
      for (const [account, direction] of [
        [s.issuance, 'debit'],
        [s.available, 'credit'],
      ] as const) {
        await app.query(
          `INSERT INTO ledger_entries (tenant_id, id, transaction_id, account_id, direction, amount, currency)
           VALUES ($1, $2, $3, $4, $5, 1, 'COIN')`,
          [s.tenant, uuidv7(), txId, account, direction],
        );
      }
    });
    await expect(late).rejects.toThrow(/sealed/i);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id = $1`,
      [s.tenant],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe('INV-L7 a wallet and the tenant system accounts exist once (F7)', () => {
  // Mutation: drop UNIQUE (tenant_id, user_id) on wallet_owner_links, or the partial/compound uniques
  // on accounts. Parallel first credits then create duplicates (see D1-11).
  it('a second link for the same user in a tenant violates the unique constraint', async () => {
    const s = await seed();
    const { rows } = await admin.query(
      `SELECT user_id FROM wallet_owner_links WHERE tenant_id = $1`,
      [s.tenant],
    );
    const other = uuidv7();
    await inTenant(app, s.tenant, () =>
      app.query(`INSERT INTO wallets (tenant_id, id, sandbox) VALUES ($1, $2, false)`, [
        s.tenant,
        other,
      ]),
    );
    expect(
      await attempt(
        s.tenant,
        `INSERT INTO wallet_owner_links (tenant_id, wallet_id, user_id, sandbox) VALUES ($1, $2, $3, false)`,
        [s.tenant, other, rows[0].user_id],
      ),
    ).toMatch(/unique|duplicate/i);
  });

  it('a second tenant_issuance or tenant_redeemed account in a tenant is refused', async () => {
    const s = await seed();
    for (const kind of ['tenant_issuance', 'tenant_redeemed']) {
      expect(
        await attempt(
          s.tenant,
          `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency, sandbox) VALUES ($1, $2, $3, NULL, 'COIN', false)`,
          [s.tenant, uuidv7(), kind],
        ),
      ).toMatch(/unique|duplicate/i);
    }
  });

  it('a second player_available or player_held account for one wallet is refused', async () => {
    const s = await seed();
    for (const kind of ['player_available', 'player_held']) {
      expect(
        await attempt(
          s.tenant,
          `INSERT INTO accounts (tenant_id, id, kind, wallet_id, currency, sandbox) VALUES ($1, $2, $3, $4, 'COIN', false)`,
          [s.tenant, uuidv7(), kind, s.wallet],
        ),
      ).toMatch(/unique|duplicate/i);
    }
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

// The exact table privileges of the runtime role (decision D-9). They live in ONE migration, `Ledger`
// (run as `payments`); `init.sh` only creates the role and its CONNECT. Any extra privilege, any
// missing one, any new table that is not listed here fails the test.
const TABLE_GRANTS: Record<string, string[]> = {
  accounts: ['INSERT', 'SELECT'],
  // 1732300002000-AuditIntents (D-21/D-23 F4): the service-kit audit port inserts the intent, the
  // finalize and the sweeper DELETE ... RETURNING it. No UPDATE: an intent is never rewritten.
  audit_intents: ['DELETE', 'INSERT', 'SELECT'],
  balances: ['INSERT', 'SELECT'], // UPDATE is column-level, see COLUMN_UPDATES
  billing_plans: ['SELECT'],
  billing_webhook_events: ['INSERT', 'SELECT'],
  inbox: ['INSERT', 'SELECT'],
  idempotency_keys: ['INSERT', 'SELECT'],
  invoices: ['INSERT', 'SELECT'],
  journal_transactions: ['INSERT', 'SELECT'],
  ledger_entries: ['INSERT', 'SELECT'],
  outbox: ['INSERT', 'SELECT', 'UPDATE'],
  payment_attempts: ['INSERT', 'SELECT', 'UPDATE'],
  reconciliation_runs: ['INSERT', 'SELECT'],
  reconciliation_tenants: ['INSERT', 'SELECT'],
  reserves: ['INSERT', 'SELECT'], // UPDATE is column-level
  subscriptions: ['INSERT', 'SELECT', 'UPDATE'],
  usage_events: ['INSERT', 'SELECT'],
  usage_meters: ['INSERT', 'SELECT', 'UPDATE'],
  usage_players: ['INSERT', 'SELECT'],
  usage_reports: ['INSERT', 'SELECT'],
  wallet_owner_links: ['DELETE', 'INSERT', 'SELECT'],
  wallets: ['INSERT', 'SELECT'],
};
const COLUMN_UPDATES = ['balances.amount', 'reserves.state', 'reserves.state_changed_at'];
/** Public tables the runtime role has no privilege on at all. */
const NO_GRANTS = ['migrations'];

describe('INV-L2b the runtime role has exactly the grants the spec lists', () => {
  // Mutation: grant anything extra (TRUNCATE, UPDATE on journal_*, DELETE beyond links, PUBLIC access,
  // a table-wide UPDATE on balances or reserves), forget one, or add a table without listing it here.
  it('table privileges equal the pinned map, with no PUBLIC grant and no unlisted table', async () => {
    const tables = await admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname COLLATE "C"`,
    );
    expect(tables.rows.map((r) => r.relname)).toEqual(
      [...Object.keys(TABLE_GRANTS), ...NO_GRANTS].sort(),
    );

    const grants = await admin.query(
      `SELECT c.relname AS tbl, x.privilege_type AS priv, x.grantee::regrole::text AS grantee
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              LATERAL aclexplode(c.relacl) x
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND (x.grantee = 'payments_app'::regrole OR x.grantee = 0)`,
    );
    const actual: Record<string, string[]> = {};
    for (const g of grants.rows) {
      expect(g.grantee).toBe('payments_app'); // nothing to PUBLIC (grantee 0 prints as "-")
      (actual[g.tbl] ??= []).push(g.priv);
    }
    for (const k of Object.keys(actual)) actual[k]!.sort();
    expect(actual).toEqual(TABLE_GRANTS);
  });

  it('column-level UPDATE is limited to balances.amount and the reserve state columns', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname || '.' || a.attname AS col
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace,
              LATERAL aclexplode(a.attacl) x
        WHERE n.nspname = 'public' AND x.grantee = 'payments_app'::regrole
          AND x.privilege_type = 'UPDATE' ORDER BY (c.relname || '.' || a.attname) COLLATE "C"`,
    );
    expect(rows.map((r) => r.col)).toEqual([...COLUMN_UPDATES].sort());
  });

  it('is not a member of the owner role, can connect, and cannot create objects', async () => {
    const { rows } = await admin.query(
      `SELECT pg_has_role('payments_app', 'payments_owner', 'MEMBER') AS member,
              has_database_privilege('payments_app', 'payments', 'CONNECT') AS connect,
              has_schema_privilege('payments_app', 'public', 'CREATE') AS can_create,
              (SELECT rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname = 'payments_app') AS privileged`,
    );
    expect(rows[0]).toEqual({ member: false, connect: true, can_create: false, privileged: false });
  });

  it('cannot rewrite what it may insert: no UPDATE of a journal or of a balance owner column', async () => {
    const s = await seed();
    expect(await attempt(s.tenant, `UPDATE balances SET tenant_id = tenant_id`)).toMatch(
      /permission denied/i,
    );
    expect(await attempt(s.tenant, `UPDATE reserves SET amount = amount`)).toMatch(
      /permission denied/i,
    );
    expect(await attempt(s.tenant, `TRUNCATE ledger_entries`)).toMatch(/permission denied/i);
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
    'wallet_owner_links',
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
    // The control: A really has a row there (a table with no rows would pass without RLS).
    expect(
      (
        await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
          a.tenant,
        ])
      ).rows[0].n,
    ).toBeGreaterThan(0);
    expect((await count(b.tenant)).rows[0].n).toBe(0);
    expect((await count(null)).rows[0].n).toBe(0);
  });

  // Tables that are tenant-less on purpose; everything else must be tenant-isolated, FORCEd (the
  // owner is bound too) and carry a policy. A new table is isolated by default.
  // Mutation: create any new table without `enableTenantRls`, or remove FORCE from one.
  const GLOBAL_TABLES = [
    'billing_plans',
    'inbox',
    'outbox',
    'migrations',
    'reconciliation_tenants',
    // NOT `audit_intents` (stack triage, D-24): the intent row stores the whole acting envelope
    // (target tenant_id, acting admin, route) for up to 60 s, so it is tenant data and needs FORCE
    // RLS like any work queue. Only an owner decision may move it here, with its reason.
  ];
  // D-24 behaviour at the choke point, raw SQL as the runtime role: a tenant transaction never reads
  // another tenant's audit intent. Was red when written: `audit_intents` has no tenant_id and no policy
  // (packages/service-kit/src/audit-intents.ts:30-34), so B's transaction reads A's intent.
  // Fix direction (coder): tenant_id + enableTenantRls, the sweeper reading through the platform path.
  // Mutation once green: disable or drop the policy on audit_intents -> red.
  it('INV-L6b a tenant transaction cannot read another tenant audit intent (D-24)', async () => {
    const a = uuidv7();
    const b = uuidv7();
    const eventId = uuidv7();
    const envelope = { event_id: eventId, type: 'audit.acting_request', tenant_id: a };
    // Seeded as the admin so the seed does not depend on the column set the fix chooses.
    const cols = await admin.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = 'public.audit_intents'::regclass
          AND attname = 'tenant_id' AND NOT attisdropped`,
    );
    if (cols.rows.length > 0) {
      await admin.query(
        `INSERT INTO audit_intents (event_id, envelope, tenant_id) VALUES ($1, $2, $3)`,
        [eventId, envelope, a],
      );
    } else {
      await admin.query(`INSERT INTO audit_intents (event_id, envelope) VALUES ($1, $2)`, [
        eventId,
        envelope,
      ]);
    }
    try {
      // Control: the row is there.
      const all = await admin.query(
        `SELECT count(*)::int AS n FROM audit_intents WHERE event_id = $1`,
        [eventId],
      );
      expect(all.rows[0].n).toBe(1);
      const seen = await inTenant(app, b, () =>
        app.query(`SELECT count(*)::int AS n FROM audit_intents WHERE event_id = $1`, [eventId]),
      );
      expect(seen.rows[0].n).toBe(0);
    } finally {
      await admin.query(`DELETE FROM audit_intents WHERE event_id = $1`, [eventId]);
    }
  });
  it('every other table in public has ENABLE + FORCE row level security and a policy', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relname = ANY($1))
        ORDER BY c.relname COLLATE "C"`,
      [GLOBAL_TABLES],
    );
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) expect(r).toMatchObject({ enabled: true, forced: true, policies: 1 });
    // And the allow-list is honest: none of them carries a tenant's payments data.
    const { rows: global } = await admin.query(
      `SELECT c.relname, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'amount') AS has_amount
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [GLOBAL_TABLES],
    );
    for (const r of global) expect(r.has_amount).toBe(false);
  });
});

describe('INV-O1 the identity link is erasable; the account id and the ledger stay', () => {
  // Mutation: add a user_id column to wallets/accounts, or make the link a FK that cascades.
  it('no ledger table other than the link carries a user id', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('user_id','owner_user_id','player_id','email')
          AND table_name IN ('wallets','accounts','balances','journal_transactions','ledger_entries','reserves',
                             'usage_events','usage_meters','usage_players','usage_reports')`,
    );
    expect(rows).toEqual([]);
  });

  // Mutation: revoke DELETE on wallet_owner_links from payments_app, or cascade it into the ledger.
  it('deleting the link leaves wallet, accounts, balances and entries untouched', async () => {
    const s = await seed(); // the seed already links the wallet to a user
    await post(s, balanced(s, 9));
    await inTenant(app, s.tenant, () =>
      app.query(`DELETE FROM wallet_owner_links WHERE tenant_id = $1 AND wallet_id = $2`, [
        s.tenant,
        s.wallet,
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
