import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/*
 * Fix-round re-review, coordinator question 12 (INV-ENV-INPUT, rule 3: the environment comes only
 * from the verified credential, the launch token or a stored row). The final coder's mutation b
 * put a literal `sandbox: false` into the ingest insertIfAbsent, the spin key and the saga order key,
 * and no test noticed. This scan is the choke point for that class: in non-test sources, a call that
 * builds an environment-scoped key, row, event, room or wallet read may not receive a LITERAL
 * boolean as its environment. Every literal that is there on purpose is listed below, per file and
 * call, with its count and reason, so a second literal in the same call site is still caught.
 *
 * ENV-LIT-0 (self-test): the scan sees the sources (non-zero files and call sites) and catches a
 *   planted literal in a fixture string.
 * ENV-LIT-1: the literals found equal the reasoned allow-list.
 *   Mutations (each -> red): `sandbox: false` in ingestion.service insertIfAbsent; in spin.service's
 *   flight or spin key; in redemption-saga.service's key helper; in redemption.store placeOrder's
 *   order key; in a createEvent of the spin or deposit path.
 */

const ROOT = resolve(__dirname, '../../..');
const CALLS = [
  'scopedKey',
  'insertIfAbsent',
  'createEvent',
  'placeOrder',
  'roomName',
  'readByPlayer',
  'emitPlayerEvent',
  'emitPlayerEventAfterCommit',
];

/** file:call -> [count, reason]. */
const ALLOWED: Record<string, [number, string]> = {
  'apps/payments/src/services/usage.service.ts:scopedKey': [
    1,
    'usage is metered for production only (D-13; recordSpin returns early on a sandbox event)',
  ],
  'apps/identity/src/services/tenants.service.ts:createEvent': [
    1,
    'identity.tenant.created: a tenant is not environment scoped',
  ],
  'packages/service-kit/src/service-auth.ts:createEvent': [
    1,
    'audit.service_call: a service token has no environment (see Q4 in the re-review)',
  ],
  'apps/payments/src/controllers/balance.controller.ts:readByPlayer': [
    1,
    'operator reads the production wallet by design (env-input spec section 2, row 14)',
  ],
};

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === 'testing') return [];
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
};

const sources = (): string[] =>
  ['apps', 'packages']
    .flatMap((top) => readdirSync(join(ROOT, top)).map((n) => join(ROOT, top, n, 'src')))
    .flatMap(walk)
    .filter((f) => /\.ts$/.test(f) && !/\.(test|spec|itest|pgtest)\.ts$|\.d\.ts$/.test(f))
    .filter((f) => !/\/migrations\//.test(f));

/** The argument text of every `name(` call in `text` (balanced parentheses). */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*\\(|\\.${name}\\s*\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // skip the declaration itself (`function scopedKey(`, `async insertIfAbsent(`, `scopedKey = (`)
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (/(function|async)\s+$/.test(before)) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push(text.slice(start, i));
  }
  return out;
}

const LITERAL = /\bsandbox\s*:\s*(true|false)\b/g;

function literalsIn(text: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const call of CALLS) {
    // `emitPlayerEvent(` must not also count `emitPlayerEventAfterCommit(`: the regex is exact.
    for (const args of callArgs(text, call)) {
      const n = args.match(LITERAL)?.length ?? 0;
      // positional environment: emitPlayerEvent*(tenant, player, <bool>, ...)
      const positional =
        call.startsWith('emitPlayerEvent') &&
        /^[^,]+,[^,]+,(?:\s*[^,]+,)?\s*(true|false)\s*,/.test(args)
          ? 1
          : 0;
      if (n + positional > 0) found[call] = (found[call] ?? 0) + n + positional;
    }
  }
  return found;
}

describe('fix-round re-review: no literal environment at a key, row or event (Q12)', () => {
  it('ENV-LIT-0 the scan sees the sources and catches a planted literal', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(100);
    const sites = files
      .map((f) => readFileSync(f, 'utf8'))
      .reduce((n, t) => n + CALLS.reduce((k, c) => k + callArgs(t, c).length, 0), 0);
    expect(sites).toBeGreaterThan(20);
    const planted = [
      "const k = scopedKey({ kind: 'spin', tenantId, sandbox: false, parts: [a] });",
      'await this.inbound.insertIfAbsent(tx, { tenantId, sandbox: true, source });',
      'emitPlayerEventAfterCommit(tx, tenantId, playerId, false, { event: x });',
    ].join('\n');
    expect(literalsIn(planted)).toEqual({
      scopedKey: 1,
      insertIfAbsent: 1,
      emitPlayerEventAfterCommit: 1,
    });
    // and a real value is not a literal
    expect(literalsIn('scopedKey({ kind, tenantId, sandbox: r.sandbox, parts })')).toEqual({});
  });

  it('ENV-LIT-1 every literal environment at such a call is on the reasoned allow-list', () => {
    const found: Record<string, number> = {};
    for (const f of sources()) {
      const rel = relative(ROOT, f);
      for (const [call, n] of Object.entries(literalsIn(readFileSync(f, 'utf8')))) {
        found[`${rel}:${call}`] = n;
      }
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([k, [n]]) => [k, n]));
    expect(found).toEqual(expected);
  });
});
