import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { EventEnvelope } from '@ex-mio/contracts';
import { currentAuth, ServiceAuthModule } from './service-auth';
import { accessClaims, generateRsaKey, signJwt } from './testing/jwt-fixtures';

/*
 * D-29 INV-ENV-INPUT (docs/specs/env-input.md section 4), repo-wide choke points.
 *
 * INV-ENV-INPUT-2 static scan (RED). Rule 2 of the spec: no `.default(` and no fallback for
 *   `environment`, `sandbox` or `sbx`. Three parts:
 *   2a `.default(` on such a field in packages/contracts/src and every apps/<svc>/src/controllers;
 *   2b a fallback (`?? false`, `?? 'production'`, `|| false`, `= { sandbox: false }`, a parameter
 *      default `environment = 'production'` / `sandbox = false`) in any non-test source, test
 *      HELPERS included (spec #24, N-6: fakes and harnesses are sources the saga tests trust);
 *   2c an OPTIONAL environment field (`sandbox?:`, `environment?:`, `.optional()` on those names):
 *      "absent means production" is a fallback by another name (spec #9 N-3, #11 N-4).
 *   Each part first proves it sees files (a count) and catches a planted fixture.
 *   Mutation: add one `.default(` or fallback on an environment field -> its part goes red with the
 *   file:line.
 * INV-ENV-INPUT-7 DDL default, migration history (RED; the catalog half is the compose test
 *   tests/compose/src/review-env-input-ddl.compose.test.ts). Decision recorded with the spec (3.5):
 *   a `DEFAULT` on an environment column IS allowed in the migration that adds the column to a
 *   table with rows (a backfill: existing rows are production), on one condition: a LATER migration
 *   drops it (`ALTER COLUMN ... DROP DEFAULT`), so the final schema has none and no writer can rely
 *   on it. A DEFAULT that is never dropped fails. Mutation: re-add `DEFAULT false` in a new
 *   migration without a drop -> red.
 * INV-ENV-INPUT-3 the auth context is total (RED, spec 3.2, #9). For a user token with and without
 *   `sbx`, `currentAuth()` carries a defined environment (`sandbox: boolean` or
 *   `environment: 'production' | 'sandbox'`, whichever the coder picks). Mutation: the verifier
 *   sets it only when the token is a sandbox one -> red.
 */

const ROOT = resolve(__dirname, '../../..');
const ENV = '(?:sandbox|environment|sbx)';

const walk = (dir: string): string[] => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === '.next') return [];
    const rel = join(dir, name);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
};
const isTestFile = (f: string) =>
  /\.(test|spec|itest|pgtest)\.tsx?$/.test(f) || /\.pg\.itest\.ts$/.test(f);
const tsSources = (dirs: string[]) =>
  dirs.flatMap(walk).filter((f) => /\.tsx?$/.test(f) && !isTestFile(f) && !f.endsWith('.d.ts'));
/** Comments dropped, newlines kept (hit line numbers are the file's). */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1');
const SERVICE_SRC = ['identity', 'engagement', 'payments'].map((s) => `apps/${s}/src`);
const PACKAGE_SRC = readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`);

/** Every line of `src` that matches `re`, as `file:line  text`. */
export function hits(rel: string, src: string, re: RegExp): string[] {
  return code(src)
    .split('\n')
    .flatMap((line, i) => (re.test(line) ? [`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`] : []));
}

const DEFAULT_RE = new RegExp(`\\b${ENV}\\b\\s*:[^\\n]*\\.default\\(`);
const FALLBACK_RE = new RegExp(
  [
    `\\b${ENV}\\b[^\\n;]*(?:\\?\\?|\\|\\|)\\s*(?:false|'production'|"production")`,
    `=\\s*\\{\\s*sandbox\\s*:\\s*false\\s*\\}`,
    `\\b${ENV}\\b\\s*(?::\\s*[\\w'"| ]+)?=\\s*(?:false|'production'|"production")\\s*[,)]`,
  ].join('|'),
);
const OPTIONAL_RE = new RegExp(`\\b${ENV}\\?\\s*:|\\b${ENV}\\b\\s*:\\s*[^\\n]*\\.optional\\(\\)`);

/**
 * Exceptions, each with its reason. The token CLAIM stays optional (a JWT encodes the production
 * environment by the claim's absence, spec 3.2); the verifier is the one place that turns it into a
 * total value, and INV-ENV-INPUT-3 pins that.
 */
const OPTIONAL_ALLOWED: Record<string, string> = {
  'packages/contracts/src/identity.ts': 'AccessTokenClaims.sbx: the JWT claim encoding (spec 3.2)',
  'packages/service-kit/src/testing/jwt-fixtures.ts':
    'accessClaims({ sbx?: true }): builds the JWT claim, whose absence IS the production encoding',
  'apps/engagement/src/testing/auth.fixture.ts': 'player token builder: the JWT claim encoding',
  'apps/payments/src/testing/auth.ts': 'player token builder: the JWT claim encoding',
  'apps/identity/src/services/sessions.service.ts':
    'issueUserToken input `sbx?: true` mirrors the claim; spec 3.2 makes `environment` required there, so this entry must go when that lands',
};

describe('INV-ENV-INPUT-2 static scan: no default and no fallback for an environment field (spec rule 2)', () => {
  it('INV-ENV-INPUT-2-0 the patterns catch planted fixtures and spare the required forms', () => {
    expect(
      hits('x.ts', `  environment: IntegrationEnvironment.default('production'),`, DEFAULT_RE),
    ).toHaveLength(1);
    expect(
      hits(
        'x.ts',
        `const E = z.object({ sandbox: z.enum(['true','false']).default('false') })`,
        DEFAULT_RE,
      ),
    ).toHaveLength(1);
    expect(hits('x.ts', `  options.environment ?? 'production',`, FALLBACK_RE)).toHaveLength(1);
    expect(hits('x.ts', `const s = config.sandbox ?? false;`, FALLBACK_RE)).toHaveLength(1);
    expect(
      hits('x.ts', `opts: { sandbox: boolean } = { sandbox: false },`, FALLBACK_RE),
    ).toHaveLength(1);
    expect(
      hits(
        'x.ts',
        `issueFor(s: Subject, p: string, environment: IntegrationEnvironment = 'production',`,
        FALLBACK_RE,
      ),
    ).toHaveLength(1);
    expect(hits('x.ts', `  sandbox?: boolean;`, OPTIONAL_RE)).toHaveLength(1);
    expect(hits('x.ts', `  sandbox: z.boolean().optional(),`, OPTIONAL_RE)).toHaveLength(1);
    expect(hits('x.ts', `  environment: IntegrationEnvironment,`, DEFAULT_RE)).toHaveLength(0);
    expect(hits('x.ts', `  sandbox: boolean;`, OPTIONAL_RE)).toHaveLength(0);
    expect(hits('x.ts', `  readByPlayer(id, { sandbox: false })`, FALLBACK_RE)).toHaveLength(0); // an explicit argument
  });

  it('INV-ENV-INPUT-2a no `.default(` on an environment field in contracts or a controller', () => {
    const files = tsSources([
      'packages/contracts/src',
      ...SERVICE_SRC.map((s) => `${s}/controllers`),
    ]);
    expect(files.length).toBeGreaterThan(30);
    expect(files.flatMap((f) => hits(f, readFileSync(join(ROOT, f), 'utf8'), DEFAULT_RE))).toEqual(
      [],
    );
  });

  it('INV-ENV-INPUT-2b no fallback for an environment value in any source, test helpers included', () => {
    const files = tsSources([...SERVICE_SRC, ...PACKAGE_SRC]);
    expect(files.length).toBeGreaterThan(150);
    expect(files.flatMap((f) => hits(f, readFileSync(join(ROOT, f), 'utf8'), FALLBACK_RE))).toEqual(
      [],
    );
  });

  it('INV-ENV-INPUT-2c no optional environment field ("absent means production")', () => {
    const files = tsSources([...SERVICE_SRC, ...PACKAGE_SRC]);
    const found = files
      .filter((f) => !(f in OPTIONAL_ALLOWED))
      .flatMap((f) => hits(f, readFileSync(join(ROOT, f), 'utf8'), OPTIONAL_RE));
    expect(found).toEqual([]);
  });
});

describe('INV-ENV-INPUT-7 no environment column keeps a DEFAULT (migration history, spec 3.5)', () => {
  const MIGRATION_DIRS = SERVICE_SRC.map((s) => `${s}/model/migrations`);

  /** `<table>.<column>` for every environment column given a DEFAULT, and every later DROP DEFAULT. */
  function history(): { defaults: Map<string, string>; dropped: Set<string> } {
    const defaults = new Map<string, string>();
    const dropped = new Set<string>();
    const files = MIGRATION_DIRS.flatMap(walk)
      .filter((f) => /\/\d{13}-[\w-]+\.ts$/.test(f))
      .sort((a, b) => a.split('/').pop()!.localeCompare(b.split('/').pop()!));
    for (const f of files) {
      const src = code(readFileSync(join(ROOT, f), 'utf8'));
      let table = '';
      for (const [i, line] of src.split('\n').entries()) {
        const t = /(?:CREATE TABLE|ALTER TABLE)\s+(?:IF NOT EXISTS\s+)?"(\w+)"/.exec(line);
        if (t) table = t[1]!;
        const d = /"(sandbox|environment)"[^,\n]*\bDEFAULT\b/i.exec(line);
        if (d && !/DROP DEFAULT/i.test(line)) defaults.set(`${table}.${d[1]}`, `${f}:${i + 1}`);
        const x = /ALTER COLUMN\s+"(sandbox|environment)"\s+DROP DEFAULT/i.exec(line);
        if (x) dropped.add(`${table}.${x[1]}`);
      }
    }
    return { defaults, dropped };
  }

  it('INV-ENV-INPUT-7a every DEFAULT on an environment column is dropped by a later migration', () => {
    const { defaults, dropped } = history();
    expect(defaults.size).toBeGreaterThan(0); // the scan sees the history (today: 9 columns)
    const kept = [...defaults]
      .filter(([col]) => !dropped.has(col))
      .map(([col, at]) => `${col} (${at})`);
    expect(kept).toEqual([]);
  });
});

// ---- INV-ENV-INPUT-3 ------------------------------------------------------------------------

const NOW = 1_790_000_000;
const T = '0190a1b2-c3d4-7e5f-8a6b-00000000e001';
const USER = '0190a1b2-c3d4-7e5f-8a6b-00000000e0a1';
const key1 = generateRsaKey('k1');

@Controller()
class EnvProbe {
  @Get('v1/env-probe')
  probe() {
    const a = currentAuth() as unknown as { sandbox?: unknown; environment?: unknown };
    return { sandbox: a.sandbox ?? 'ABSENT', environment: a.environment ?? 'ABSENT' };
  }
}

describe('INV-ENV-INPUT-3 the auth context always carries the environment (spec 3.2, #9)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    @Module({
      imports: [
        ServiceAuthModule.forService({
          audience: 'engagement',
          serviceCalls: {} as never,
          auditPort: async (_e: EventEnvelope) => undefined,
          jwks: async () => ({ keys: [key1.publicJwk] }),
          tenantStatus: async () => 'active' as const,
          nowSeconds: () => NOW,
        }),
      ],
      controllers: [EnvProbe],
    })
    class App {}
    app = await NestFactory.create<NestFastifyApplication>(App, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  const probe = async (sbx: boolean) => {
    const token = signJwt({
      alg: 'RS256',
      key: key1.privateKey,
      kid: 'k1',
      claims: accessClaims({
        now: NOW,
        sub: USER,
        tid: T,
        roles: ['player'],
        aud: 'engagement',
        ...(sbx ? { sbx: true as const } : {}),
      }),
    });
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/v1/env-probe',
        headers: { authorization: `Bearer ${token}` },
      });
    expect(res.statusCode).toBe(200);
    return res.json() as { sandbox: unknown; environment: unknown };
  };
  const isProduction = (b: { sandbox: unknown; environment: unknown }) =>
    b.sandbox === false || b.environment === 'production';
  const isSandbox = (b: { sandbox: unknown; environment: unknown }) =>
    b.sandbox === true || b.environment === 'sandbox';

  it('INV-ENV-INPUT-3a a production token (no sbx claim) gives a DEFINED production environment', async () => {
    const b = await probe(false);
    expect(isProduction(b)).toBe(true);
    expect(isSandbox(b)).toBe(false);
  });

  it('INV-ENV-INPUT-3b a sandbox token gives the sandbox environment', async () => {
    const b = await probe(true);
    expect(isSandbox(b)).toBe(true);
    expect(isProduction(b)).toBe(false);
  });
});
