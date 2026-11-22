import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * INV-ENV-KEYS (coordinator decision D-26, test owner, written before the fix).
 *
 * Environment scoping was "fixed" three times at a call site (R1 spin credits, F5 integration
 * secrets, R2 ingest dedupe) and moved each time. D-26 closes it at the choke point: every dedupe,
 * idempotency, inbox, lock or order key that code BUILDS goes through ONE helper, and that helper
 * cannot be called without the environment.
 *
 * The contract (the coder implements it; nothing here is implementation):
 *
 *   packages/contracts/src/scoped-key.ts, exported from `@ex-mio/contracts`:
 *
 *     export const SCOPED_KEY_KINDS = ['spin', 'deposit', 'order', 'hold', 'capture', 'release',
 *       'refund', 'redeem', 'usage', 'inbox', 'idempotency', 'flight'] as const;
 *     export type ScopedKeyKind = (typeof SCOPED_KEY_KINDS)[number];
 *     export interface ScopedKeyInput {
 *       kind: ScopedKeyKind;       // closed set; an unknown kind throws
 *       tenantId: string;          // a UUID; compared lower-case
 *       sandbox: boolean;          // REQUIRED; anything but a boolean throws (no default)
 *       parts: readonly string[];  // at least one non-empty string
 *     }
 *     export function scopedKey(input: ScopedKeyInput): string;
 *
 *   Properties (each pinned below): starts with `<kind>:`; deterministic; injective in
 *   (kind, tenant, sandbox, parts), including parts that contain the separator; a key with one
 *   UUID part fits the 8..128 Idempotency-Key bound of payments and engagement.
 *
 * The module is loaded by a computed path, so this file typechecks before the helper exists and each
 * test fails on its own with "scopedKey is missing" (RED for the right reason, not a syntax error).
 *
 * Mutations (re-applied by the reviewer once the helper exists):
 *  - K1: give `sandbox` a default (`sandbox = false`) -> K1 red.
 *  - K2: drop the environment from the key -> K2 red.
 *  - K4: join parts with ':' without escaping -> K4 red.
 *  - SCAN: write `const k = \`hold:${id}\`` in any non-test source -> INV-ENV-KEYS-SCAN red.
 */

type ScopedKeyInput = {
  kind: string;
  tenantId: string;
  sandbox: boolean;
  parts: readonly string[];
};
type Helper = {
  scopedKey: (input: ScopedKeyInput) => string;
  SCOPED_KEY_KINDS: readonly string[];
};

const HELPER_REL = 'packages/contracts/src/scoped-key.ts';

function helper(): Helper {
  const path = ['.', 'scoped-key'].join('/');
  let mod: Partial<Helper>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(path) as Partial<Helper>;
  } catch {
    throw new Error(`INV-ENV-KEYS: scopedKey is missing (${HELPER_REL} does not exist yet)`);
  }
  if (typeof mod.scopedKey !== 'function' || !Array.isArray(mod.SCOPED_KEY_KINDS)) {
    throw new Error(`INV-ENV-KEYS: ${HELPER_REL} must export scopedKey and SCOPED_KEY_KINDS`);
  }
  return mod as Helper;
}

/** The public package entry exports the same helper (services import `@ex-mio/contracts`). */
function fromIndex(): Partial<Helper> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(['.', 'index'].join('/')) as Partial<Helper>;
}

const T_A = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2a';
const T_B = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';
const REQUIRED_KINDS = [
  'spin',
  'deposit',
  'order',
  'hold',
  'capture',
  'release',
  'refund',
  'redeem',
  'usage',
  'inbox',
  'idempotency',
  'flight',
];

const key = (over: Partial<ScopedKeyInput> = {}) =>
  helper().scopedKey({ kind: 'spin', tenantId: T_A, sandbox: false, parts: [ID], ...over });

describe('INV-ENV-KEYS the one key helper requires the environment (D-26)', () => {
  it('INV-ENV-KEYS-0 the helper exists, is exported from @ex-mio/contracts and covers every key kind', () => {
    const h = helper();
    expect(fromIndex().scopedKey).toBe(h.scopedKey);
    expect([...h.SCOPED_KEY_KINDS].sort()).toEqual([...REQUIRED_KINDS].sort());
  });

  // Mutation: `sandbox = false` default, or `Boolean(input.sandbox)`.
  it('INV-ENV-KEYS-1 a key cannot be built without a boolean environment', () => {
    const { scopedKey } = helper();
    const base = { kind: 'spin', tenantId: T_A, parts: [ID] };
    for (const sandbox of [undefined, null, 'false', 'true', 0, 1, '']) {
      expect(() => scopedKey({ ...base, sandbox } as unknown as ScopedKeyInput)).toThrow();
    }
    expect(() => scopedKey(base as unknown as ScopedKeyInput)).toThrow();
  });

  // Mutation: leave the environment out of the key.
  it('INV-ENV-KEYS-2 the same key material in sandbox and production gives two different keys', () => {
    for (const kind of REQUIRED_KINDS) {
      expect(key({ kind, sandbox: true })).not.toBe(key({ kind, sandbox: false }));
    }
  });

  it('INV-ENV-KEYS-3 tenant and kind separate keys; the tenant is compared lower-case', () => {
    expect(key({ tenantId: T_A })).not.toBe(key({ tenantId: T_B }));
    expect(key({ tenantId: T_A.toUpperCase() })).toBe(key({ tenantId: T_A }));
    expect(key({ kind: 'capture' })).not.toBe(key({ kind: 'release' }));
  });

  // Mutation: `parts.join(':')` without escaping the separator.
  it('INV-ENV-KEYS-4 the key is injective in its parts, whatever characters they contain', () => {
    const pairs: Array<[string[], string[]]> = [
      [['a:b'], ['a', 'b']],
      [
        ['a', 'b:c'],
        ['a:b', 'c'],
      ],
      [['a|b'], ['a', 'b']],
      [['prod'], ['sbx']],
      [['x%3Ay'], ['x:y']],
    ];
    for (const [p, q] of pairs) expect(key({ parts: p })).not.toBe(key({ parts: q }));
    // a part that spells another environment cannot forge it
    expect(key({ sandbox: false, parts: ['sbx', ID] })).not.toBe(
      key({ sandbox: true, parts: [ID] }),
    );
  });

  it('INV-ENV-KEYS-5 deterministic, prefixed with its kind, fits the 8..128 Idempotency-Key bound', () => {
    expect(key()).toBe(key());
    for (const kind of REQUIRED_KINDS) {
      const k = key({ kind, sandbox: true });
      expect(k.startsWith(`${kind}:`)).toBe(true);
      expect(k.length).toBeGreaterThanOrEqual(8);
      expect(k.length).toBeLessThanOrEqual(128);
    }
  });

  it('INV-ENV-KEYS-6 malformed input is refused: unknown kind, non-UUID tenant, no parts, empty part', () => {
    const { scopedKey } = helper();
    const ok = { kind: 'spin', tenantId: T_A, sandbox: true, parts: [ID] };
    expect(() => scopedKey({ ...ok, kind: 'spins' })).toThrow();
    expect(() => scopedKey({ ...ok, tenantId: '' })).toThrow();
    expect(() => scopedKey({ ...ok, tenantId: 'tenant-a' })).toThrow();
    expect(() => scopedKey({ ...ok, parts: [] })).toThrow();
    expect(() => scopedKey({ ...ok, parts: [ID, ''] })).toThrow();
  });
});

// ---- the repository: nobody builds a key without the helper --------------------------------------

const ROOT = resolve(__dirname, '../../..');

const walk = (dir: string): string[] => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true }) as string[])
    .map((p) => join(dir, p))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !/(^|\/)(node_modules|dist|\.next)\//.test(p));
};
const srcFiles = (): string[] =>
  ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(ROOT, top)).flatMap((name) => walk(join(top, name, 'src'))),
  );
const isTestOrFixture = (rel: string) =>
  /\.(test|itest|pgtest|spec|stories)\.tsx?$/.test(rel) ||
  /(^|\/)(testing|__tests__|migrations)\//.test(rel);

/** Key kinds a string template or a join may not start with outside the helper. */
const KIND =
  '(?:spin|deposit|order|hold|capture|release|refund|redeem|usage|inbox|idem(?:potency)?|dedupe|flight)';
const RULES: Array<{ name: string; re: RegExp }> = [
  // `hold:${r.id}`, `usage:${tenantId}:${period}`, `spin|${...}`
  // (case-sensitive, and the separator is followed by the key material, not by prose)
  { name: 'template with a key prefix', re: new RegExp('`' + KIND + '[:|](?:\\$\\{|[\\w-])') },
  // ['order', tenantId, ...].join(':')
  { name: 'array join with a key prefix', re: new RegExp(`\\[\\s*['"]${KIND}['"]\\s*,`) },
  // const flightKey = `${a}|${b}`; keyOf = (id) => `...`; dedupeKey: `...`
  {
    name: 'a *key* built from a template',
    re: /\b\w*[kK]ey(?:Of)?\w*\s*(?::\s*[\w<>[\]|' ]+)?=\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*)?`/,
  },
];

/**
 * Templates that look like keys but are not dedupe/idempotency/order keys. Each is an exact
 * file:line-text pair with its reason; anything else that matches a rule is a bypass.
 */
const NOT_KEYS: Array<{ file: string; text: string; reason: string }> = [
  {
    file: 'packages/service-kit/src/service-auth.ts',
    text: 'const routeKey = `${req.method',
    reason: 'the allow-list lookup of a route template (D-14); never stored, never deduped',
  },
];

const codeLines = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !/^\s*(\*|\/\/|\/\*)/.test(text));

describe('INV-ENV-KEYS-SCAN no key is built outside scopedKey (D-26)', () => {
  const files = srcFiles().filter((f) => !isTestOrFixture(f) && f !== HELPER_REL);

  it('INV-ENV-KEYS-SCAN-0 the walk sees the repository and each rule catches its own example', () => {
    expect(files.length).toBeGreaterThan(100);
    // non-vacuous: every rule matches the shape it exists for, and none matches the helper call
    const samples = [
      '      reply = await this.deps.coins.capture(this.call(r), `capture:${r.id}`);',
      "        ['order', scope.tenantId, scope.playerId].join(':'),",
      '    const flightKey = `${tenantId}|${userId}|${input.idempotencyKey}`;',
    ];
    samples.forEach((s, i) => expect(RULES[i]!.re.test(s)).toBe(true));
    const viaHelper =
      "    const k = scopedKey({ kind: 'capture', tenantId, sandbox: r.sandbox, parts: [r.id] });";
    for (const r of RULES) expect(r.re.test(viaHelper)).toBe(false);
  });

  // Mutation: add `const k = \`hold:${id}\`` to any non-test source under apps/ or packages/.
  it('INV-ENV-KEYS-SCAN-1 every dedupe, idempotency, inbox, lock and order key goes through scopedKey', () => {
    const bypasses: string[] = [];
    for (const f of files) {
      for (const { text, line } of codeLines(f)) {
        const rule = RULES.find((r) => r.re.test(text));
        if (!rule) continue;
        if (NOT_KEYS.some((n) => n.file === f && text.includes(n.text))) continue;
        bypasses.push(`${f}:${line} [${rule.name}] ${text.trim()}`);
      }
    }
    expect(bypasses).toEqual([]);
  });

  // The allow-list cannot rot: every entry still matches a line.
  it('INV-ENV-KEYS-SCAN-2 every NOT_KEYS entry still exists', () => {
    for (const n of NOT_KEYS) {
      expect(codeLines(n.file).some(({ text }) => text.includes(n.text))).toBe(true);
    }
  });
});
