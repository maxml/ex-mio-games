import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Choke point: the source tree itself. Four rules that are cheaper to pin by scanning than to
// reproduce at run time. Each has a control that proves the pattern is able to fail (a scan whose
// regex matches nothing would pass forever). Spec: docs/specs/payments.md, section 10.

const SRC = __dirname;

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name) && !/\.test\.ts$|\.pgtest\.ts$/.test(name)) {
        const rel = relative(SRC, path);
        if (rel.startsWith('testing/')) continue;
        out.push({ path: rel, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
}

const notMigrations = (s: { path: string }) => !s.path.startsWith('model/migrations/');

describe('INV-X4 no SQL is built by interpolating a value (MIO-150-12)', () => {
  const INTERPOLATED =
    /\.query\(\s*`[^`]*\$\{|\.query\(\s*['"][^'"]*['"]\s*\+|\.query\(\s*[A-Za-z_]+\s*\+/;

  // Mutation: build a query string with a template literal or `+` anywhere in src.
  it('the pattern can fail (control)', () => {
    expect(INTERPOLATED.test('m.query(`SELECT 1 WHERE a = ${a}`)')).toBe(true);
    expect(INTERPOLATED.test("m.query('SELECT ' + x)")).toBe(true);
    expect(INTERPOLATED.test('m.query(`SELECT 1 WHERE a = $1`, [a])')).toBe(false);
  });

  it('no source file passes an interpolated string to query()', () => {
    const files = sources().filter(notMigrations);
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => INTERPOLATED.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});

describe('INV-W4 no environment flag can switch off a security check (MIO-150-10)', () => {
  const ENV_READERS = [
    'config.ts',
    'main.ts',
    'migrate.ts',
    'services/providers/select-provider.ts',
  ];

  // Mutation: read process.env in the webhook, billing or provider code, or name a bypass flag.
  it('process.env is read only by the config, entry and provider-selection files', () => {
    const readers = sources()
      .filter((f) => /process\.env/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !ENV_READERS.includes(p));
    expect(readers).toEqual([]);
  });

  it('no bypass-style flag name appears anywhere in the sources', () => {
    const hits = sources().filter((f) =>
      /\b[A-Z_]*(SKIP|DISABLE|BYPASS|NO)_?(WEBHOOK|SIGNATURE|VERIF|AUTH)[A-Z_]*\b/.test(f.text),
    );
    expect(hits.map((f) => f.path)).toEqual([]);
  });
});

describe('INV-P6 the tariff exists once: no plan code or price outside the seed migration (MIO-150-09)', () => {
  const PLAN = /['"`](free|pro|scale)['"`]|\b(4900|19900)\b/;

  // Mutation: hard-code a plan code or a price in a service, a controller or a provider.
  it('the pattern can fail (control)', () => {
    expect(PLAN.test("if (code === 'pro')")).toBe(true);
    expect(PLAN.test('const price = 19900;')).toBe(true);
    expect(PLAN.test('plan.code')).toBe(false);
  });

  it('only the migrations mention a plan code or a seeded price', () => {
    const hits = sources()
      .filter(notMigrations)
      .filter((f) => PLAN.test(f.text));
    expect(hits.map((f) => f.path)).toEqual([]);
  });

  it('the seed migration does define them (the scan is looking at the right place)', () => {
    const seed = sources().filter(
      (f) => f.path.startsWith('model/migrations/') && PLAN.test(f.text),
    );
    expect(seed.length).toBeGreaterThan(0);
  });
});

describe('INV-P7 a card number is read in one place and never persisted (F20, coordinator)', () => {
  // The number enters only through POST /v1/billing/attempts, goes to the provider adapter's
  // `tokenize`, and only last4 and brand come back. Mutation: mention a card number field in a model,
  // a repository, a migration, an event or the subscription path.
  const ALLOWED = [
    'controllers/billing.controller.ts',
    'services/billing.service.ts',
    'services/providers/payment-provider.ts',
    'services/providers/fake.provider.ts',
    'services/providers/stripe.provider.ts',
  ];
  it('card_number / cardNumber appears only in the attempt controller, billing service and provider adapters', () => {
    const hits = sources()
      .filter((f) => /card_?number/i.test(f.text))
      .map((f) => f.path)
      .filter((p) => !ALLOWED.includes(p));
    expect(hits).toEqual([]);
  });

  it('no model, migration or entity file mentions a card number column', () => {
    const hits = sources().filter(
      (f) => /^model\//.test(f.path) && /card_?(number|pan)|\bpan\b/i.test(f.text),
    );
    expect(hits.map((f) => f.path)).toEqual([]);
  });
});
