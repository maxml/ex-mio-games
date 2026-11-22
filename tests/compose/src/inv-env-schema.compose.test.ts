import type { Client } from 'pg';
import { pgAs, type Service } from './env';

/*
 * INV-ENV-SCHEMA (coordinator decision D-26; test owner, written before the fix). Compose: it reads
 * the catalogs (`pg_class`, `pg_attribute`, `pg_index`, `pg_constraint`) of the three service
 * databases after the stack's own migrate step ran, as the postgres admin.
 *
 * Environment scoping was fixed three times at a call site and moved each time (R1 spin credits,
 * F5 integration secrets, R2 ingest dedupe). D-26 states it at the schema:
 *   - every table that holds environment-scoped data carries `sandbox` (or `environment`);
 *   - every primary key, UNIQUE constraint and unique index of such a table includes that column.
 *
 * Every table of every service DB is in exactly one class below, with a reason:
 *   ENV        it has the column (found in the catalog, not listed): every unique key must include
 *              it, unless the key is in SURROGATE_KEYS.
 *   REQUIRES   environment-scoped data WITHOUT the column: red until a migration adds it (it has landed).
 *   INHERITS   environment-scoped rows whose environment is a parent row's (named); no column needed,
 *              but then EVERY unique key must be in SURROGATE_KEYS (no client or external value
 *              may decide uniqueness across environments).
 *   GLOBAL     not environment-scoped, with the reason.
 * A table in no class fails INV-ENV-SCHEMA-1, so a new table must be classified on purpose.
 *
 * SURROGATE_KEYS: a unique key whose every value is minted by our own code (a UUID, a sequence, a
 * hash of a random secret we issued), so two environments can never produce the same value. Each
 * entry pins the exact column list; change the key and the exemption no longer applies.
 *
 * Mutations (re-applied by the reviewer):
 *  - drop `sandbox` from `redemptions_order_key` (D-18) -> INV-ENV-SCHEMA-2 engagement.redemptions red;
 *  - drop `sandbox` from `wallet_owner_links (tenant_id, user_id, sandbox)` -> payments.wallet_owner_links red;
 *  - add `CREATE UNIQUE INDEX ON spin_credits (tenant_id, user_id, created_at)` -> spin_credits red;
 *  - create a new unclassified table -> INV-ENV-SCHEMA-1 red;
 *  - reward_apis `PRIMARY KEY ("tenant_id", "platform")` (no environment) -> INV-ENV-SCHEMA-2
 *    identity.reward_apis red; drop its `environment` column -> the same test red (MISSING).
 */

const ENV_COLUMNS = ['sandbox', 'environment'];

type Classes = {
  REQUIRES: Record<string, string>;
  INHERITS: Record<string, { parent: string; reason: string }>;
  GLOBAL: Record<string, string>;
};

const BUS = {
  outbox:
    'bus outbox; keyed by the producer-minted event id; the environment rides on the envelope (D-13)',
  inbox:
    'bus inbox; (consumer, event_id) where event ids are producer-minted UUIDs, never external',
  migrations: 'TypeORM migration ledger',
  audit_intents: 'audit intents keyed by a minted event id (D-21); audit is not environment data',
};

const CLASSES: Record<Service, Classes> = {
  identity: {
    REQUIRES: {
      // The casino signs the launch token and chooses its jti. A sandbox launch and a production
      // launch of the same tenant share (tenant_id, jti): a sandbox jti burns the production one.
      launch_jti:
        'single-use launch jti chosen by the casino, from a sandbox OR a production credential',
    },
    INHERITS: {},
    GLOBAL: {
      ...BUS,
      tenants: 'the tenant registry; one tenant serves both environments',
      users: 'staff and players; one user per person across environments (X-3)',
      user_roles: 'roles of a user (X-3)',
      provider_links: 'staff identity-provider link; staff are not environment-scoped',
      player_links:
        'casino player -> user mapping; one user per casino player across environments (X-3, owner question Q-ENV-1)',
      audit_log: 'durable audit record; surrogate key only',
      signing_keys: 'platform signing keys',
    },
  },
  engagement: {
    REQUIRES: {
      // rc review R2, measured on the stack: a sandbox webhook swallows the production deposit.
      inbound_events: 'deposit dedupe on the casino event id; sandbox and production webhooks (F5)',
      // A sandbox redemption takes the player's production per-player limit slot (same user, X-3).
      item_player_usage:
        'per-player redemption limit counter, consumed by sandbox and production orders',
    },
    INHERITS: {
      // A spin of a sandbox credit is a sandbox spin; but its key holds the client's Idempotency-Key.
      spins: { parent: 'spin_credits', reason: 'the environment of the credit it consumed' },
      redemption_history: { parent: 'redemptions', reason: 'append-only history of one order' },
      redemption_work_queue: { parent: 'redemptions', reason: 'due work of one order' },
    },
    GLOBAL: {
      ...BUS,
      tenant_projections: 'copy of the tenant registry',
      rules: 'operator rule configuration; both environments run the same rules',
      reward_tables: 'operator wheel configuration; both environments spin the same table',
      store_items:
        'operator catalog; NOTE the stock counter is shared by sandbox orders (owner question Q-ENV-2)',
      redemption_inbox:
        'saga inbox; (tenant, consumer, event_id) with producer-minted event ids (D-18)',
    },
  },
  payments: {
    REQUIRES: {},
    INHERITS: {
      balances: { parent: 'accounts', reason: 'one balance row per account' },
      ledger_entries: { parent: 'accounts', reason: 'legs post to accounts of one environment' },
      journal_transactions: {
        parent: 'accounts',
        reason: 'a journal transaction is the legs of one environment (through ledger_entries)',
      },
      reserves: { parent: 'wallets', reason: 'a hold on one wallet' },
    },
    GLOBAL: {
      ...BUS,
      idempotency_keys:
        'HTTP idempotency store; keys built by our services arrive scoped by scopedKey (INV-ENV-KEYS)',
      usage_events: 'metering; production only, sandbox is never metered (D-13, INV-M5)',
      usage_meters: 'metering; production only (D-13)',
      usage_players: 'MAU metering; production only (D-13)',
      usage_reports: 'usage report to the billing provider; production only (D-13)',
      reconciliation_runs: 'one run checks both environments (ledger-jobs X-2 test)',
      reconciliation_tenants: 'id-only registry of tenants for the scheduled job',
      billing_plans: "MIO's tariff map",
      subscriptions: "the operator's MIO subscription, not casino data",
      invoices: "the operator's MIO invoices",
      payment_attempts: "the operator's MIO card payments",
      billing_webhook_events: "the billing provider's webhook dedupe (not a casino)",
    },
  },
};

/** `table(col,col)` -> why every value of that key is minted by our own code. */
const SURROGATE_KEYS: Record<string, string> = {
  // identity
  'integration_credentials(tenant_id,key_id)': 'key_id is minted by identity (prefix + random)',
  'integration_credentials(tenant_id,api_key_hash)': 'hash of a random API key identity issued',
  // engagement
  'spin_credits(tenant_id,id)': 'uuidv7 minted by engagement',
  'spin_credits(tenant_id,source_event_id,rule_id,seq)':
    'source_event_id is inbound_events.id, a uuidv7 minted by engagement, never the casino id',
  // Final review: since EnvScopedKeys this is NOT minted. The id is a hash of
  // scopedKey('spin', tenant, sandbox, [user, Idempotency-Key]): the spin dedupe key, with the
  // environment inside the derivation. Pinned by SPIN-DEDUPE-1..3 (review-final-spin-dedupe.test.ts).
  'spins(tenant_id,id)': 'uuid derived from the environment-scoped spin key (D-26)',
  'redemptions(tenant_id,id)': 'uuidv7 minted by engagement',
  'redemption_history(tenant_id,id)': 'identity sequence',
  'redemption_work_queue(tenant_id,redemption_id)': 'the order id, minted by engagement',
  // payments
  'wallets(tenant_id,id)': 'uuidv7 minted by payments',
  'wallet_owner_links(tenant_id,wallet_id)': 'the wallet id, minted by payments per environment',
  'accounts(tenant_id,id)': 'uuidv7 minted by payments',
  'accounts(tenant_id,wallet_id,kind)': 'the wallet id is per environment, minted by payments',
  'balances(tenant_id,account_id)': 'the account id, minted by payments per environment',
  'ledger_entries(tenant_id,id)': 'uuidv7 minted by payments',
  'journal_transactions(tenant_id,id)': 'uuidv7 minted by payments',
  'journal_transactions(tenant_id,operation_type,operation_id)':
    'operation_id is a spin id or an order id, both uuidv7 minted by engagement',
  'reserves(tenant_id,id)': 'the order id, minted by engagement',
};

interface KeyRow {
  table: string;
  index: string;
  primary: boolean;
  columns: string[];
  def: string;
}

const CATALOG = {
  tables: `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  envColumns: `SELECT c.relname AS t, a.attname AS col FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0
                  AND NOT a.attisdropped AND a.attname = ANY($1)`,
  // Every PK and UNIQUE constraint is backed by a unique index, so pg_index sees all three kinds.
  // Only key columns count (indnkeyatts), never INCLUDE columns; an expression is `expr`.
  uniqueKeys: `SELECT t.relname AS "table", ic.relname AS "index", i.indisprimary AS "primary",
                      ARRAY(SELECT (CASE WHEN k.attnum = 0 THEN 'expr' ELSE a.attname::text END)::text
                              FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                              LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                             WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns,
                      pg_get_indexdef(i.indexrelid) AS def
                 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
                 JOIN pg_class ic ON ic.oid = i.indexrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = 'public' AND i.indisunique ORDER BY 1, 2`,
};

interface Catalog {
  tables: string[];
  env: Map<string, string>;
  keys: KeyRow[];
}

const catalogs = new Map<Service, Catalog>();

async function read(db: Client): Promise<Catalog> {
  const tables = (await db.query(CATALOG.tables)).rows.map((r) => r.t as string);
  const env = new Map<string, string>();
  for (const r of (await db.query(CATALOG.envColumns, [ENV_COLUMNS])).rows) env.set(r.t, r.col);
  const keys = (await db.query(CATALOG.uniqueKeys)).rows as KeyRow[];
  return { tables, env, keys };
}

beforeAll(async () => {
  for (const service of ['identity', 'engagement', 'payments'] as const) {
    const db = await pgAs('postgres', service);
    try {
      catalogs.set(service, await read(db));
    } finally {
      await db.end();
    }
  }
});

const cat = (s: Service): Catalog => {
  const c = catalogs.get(s);
  if (!c) throw new Error(`no catalog for ${s}`);
  return c;
};
const sig = (k: KeyRow) => `${k.table}(${k.columns.join(',')})`;
const keysOf = (s: Service, table: string) => cat(s).keys.filter((k) => k.table === table);

/** The keys of `table` that neither include the env column nor are an exempt surrogate key. */
const offendingKeys = (s: Service, table: string, envColumn: string | undefined): string[] =>
  keysOf(s, table)
    .filter((k) => !(envColumn && k.columns.includes(envColumn)))
    .filter((k) => !(sig(k) in SURROGATE_KEYS))
    .map((k) => `${k.index}: ${k.def}`);

describe.each(['identity', 'engagement', 'payments'] as const)(
  'INV-ENV-SCHEMA %s database (D-26)',
  (service) => {
    const cls = CLASSES[service];

    // Mutation: create a table no class lists.
    it(`INV-ENV-SCHEMA-1 ${service}: every table is classified (env column, requires, inherits, global)`, () => {
      const c = cat(service);
      expect(c.tables.length).toBeGreaterThan(5); // the stack migrated this database
      const listed = new Set([
        ...Object.keys(cls.REQUIRES),
        ...Object.keys(cls.INHERITS),
        ...Object.keys(cls.GLOBAL),
      ]);
      const unclassified = c.tables.filter((t) => !c.env.has(t) && !listed.has(t));
      expect(unclassified).toEqual([]);
      // a table with the column is ENV; it must not also claim to be global or to inherit
      const contradictions = c.tables.filter(
        (t) => c.env.has(t) && (t in cls.GLOBAL || t in cls.INHERITS),
      );
      expect(contradictions).toEqual([]);
      // the lists do not rot: every listed table exists
      expect([...listed].filter((t) => !c.tables.includes(t))).toEqual([]);
    });

    // The ENV tables found in the catalog at write time; a REQUIRES table joins this check once it
    // has the column. Listed statically so each table is its own named test.
    const envTables: Record<Service, string[]> = {
      // reward_apis (D-27): PRIMARY KEY (tenant_id, platform, environment); one row per environment.
      identity: ['integration_credentials', 'reward_apis'],
      engagement: ['spin_credits', 'redemptions'],
      payments: ['wallets', 'wallet_owner_links', 'accounts'],
    };
    for (const table of [...envTables[service], ...Object.keys(cls.REQUIRES)]) {
      const why = cls.REQUIRES[table];
      it(`INV-ENV-SCHEMA-2 ${service}.${table} carries sandbox/environment and every unique key includes it${
        why ? ` (REQUIRES: ${why})` : ''
      }`, () => {
        const envColumn = cat(service).env.get(table);
        expect({ table, envColumn: envColumn ?? 'MISSING' }).toEqual({
          table,
          envColumn: expect.stringMatching(/^(sandbox|environment)$/),
        });
        expect(keysOf(service, table).length).toBeGreaterThan(0);
        expect(offendingKeys(service, table, envColumn)).toEqual([]);
      });
    }

    for (const [table, { parent, reason }] of Object.entries(cls.INHERITS)) {
      it(`INV-ENV-SCHEMA-3 ${service}.${table} inherits the environment of ${parent} (${reason}): every unique key is surrogate`, () => {
        const c = cat(service);
        expect(c.env.has(parent) ? parent : `${parent} has no env column`).toBe(parent);
        expect(keysOf(service, table).length).toBeGreaterThan(0);
        expect(offendingKeys(service, table, undefined)).toEqual([]);
      });
    }

    it(`INV-ENV-SCHEMA-4 ${service}: every ENV table found in the catalog is checked by INV-ENV-SCHEMA-2`, () => {
      const checked = new Set([...envTables[service], ...Object.keys(cls.REQUIRES)]);
      expect([...cat(service).env.keys()].filter((t) => !checked.has(t))).toEqual([]);
    });
  },
);

it('INV-ENV-SCHEMA-5 every SURROGATE_KEYS entry is a live unique key (the exemptions do not rot)', () => {
  const live = new Set(
    (['identity', 'engagement', 'payments'] as const).flatMap((s) => cat(s).keys.map(sig)),
  );
  expect(Object.keys(SURROGATE_KEYS).filter((k) => !live.has(k))).toEqual([]);
});
