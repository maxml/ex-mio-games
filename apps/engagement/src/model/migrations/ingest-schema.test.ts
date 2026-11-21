import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Review F2: every key of a tenant table leads with `tenant_id` (the reconciled roles test on
 * int/contracts, tests/compose/src/roles.compose.test.ts, requires it of every unique index). The
 * real database check is the compose test; this reads the migration text so a regression is also
 * caught without a stack.
 *
 * Mutation: change one `PRIMARY KEY ("tenant_id", "id")` back to `"id" uuid PRIMARY KEY`, or make
 * `spins.credit_id` reference `spin_credits ("id")` alone -> the named tests go red.
 */
const sql = readFileSync(join(__dirname, '1732200002000-IngestSchema.ts'), 'utf8');

const tableBlock = (name: string): string => {
  const m = new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\s*\\)\``).exec(sql);
  if (!m) throw new Error(`no CREATE TABLE for ${name}`);
  return m[1]!;
};
const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('IngestSchema migration: tenant-leading keys (F2)', () => {
  it.each(['inbound_events', 'spin_credits', 'spins'])(
    'INV-SCHEMA-TENANT-PK: %s has PRIMARY KEY ("tenant_id", "id"), not a bare id key',
    (table) => {
      const block = squash(tableBlock(table));
      expect(block).toMatch(/PRIMARY KEY \( ?"tenant_id", ?"id" ?\)/);
      expect(block).not.toMatch(/"id" uuid PRIMARY KEY/);
    },
  );

  it('INV-SCHEMA-TENANT-PK: every PRIMARY KEY and UNIQUE of every table of this migration starts with tenant_id', () => {
    const tables = ['inbound_events', 'rules', 'reward_tables', 'spin_credits', 'spins'];
    for (const t of tables) {
      const block = squash(tableBlock(t));
      const keys = [...block.matchAll(/(?:PRIMARY KEY|UNIQUE) \( ?([^)]*)\)/g)].map((m) => m[1]!);
      expect({ t, keys: keys.length > 0 }).toEqual({ t, keys: true });
      for (const cols of keys) {
        expect({ t, first: cols.split(',')[0]!.trim() }).toEqual({ t, first: '"tenant_id"' });
      }
      expect(block).not.toMatch(/"\w+" uuid PRIMARY KEY/);
    }
  });

  it("INV-SCHEMA-TENANT-FK: spins reference their credit by (tenant_id, id), so a spin cannot point at another tenant's credit", () => {
    const block = squash(tableBlock('spins'));
    expect(block).toMatch(
      /FOREIGN KEY \( ?"tenant_id", ?"credit_id" ?\) REFERENCES "spin_credits" \( ?"tenant_id", ?"id" ?\)/,
    );
    expect(block).not.toMatch(/REFERENCES "spin_credits" \( ?"id" ?\)/);
  });
});
