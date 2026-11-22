import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * Choke point: the repository itself (D-4, review findings F2 and F15). The behavioural tests
 * prove the shared entry point ignores a forged x-tenant-id; this scan proves nobody wrote a
 * second way in. A leftover header read, a service that wires its own tenant resolver, a
 * foundation test that still pins the placeholder, or a deploy file that still asks for the
 * removed platform token turns it red.
 *
 * Mutation: add `request.headers['x-tenant-id']` (or any forbidden name below) to any
 * non-test source under apps/ or packages/.
 */

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

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const isTest = (rel: string) => /\.test\.tsx?$/.test(rel) || /(^|\/)testing\//.test(rel);

const HEADER_NAMES =
  /x-tenant-id|x-principal-|x-platform-admin-token|x-service-id|x-service-token|x-acting-tenant|x-sandbox|HEADER_TENANT_ID|HEADER_PLATFORM_TOKEN|HEADER_SERVICE_|HEADER_PRINCIPAL_|HEADER_ACTING_|TENANT_HEADER|PRINCIPAL_HEADER|PrincipalHeaders|ServiceTokenGuard|SERVICE_TOKENS|headerTenantResolver|PLATFORM_ADMIN_TOKEN|PlatformAdminGuard/i;

const hits = (files: string[], re: RegExp) => files.filter((f) => re.test(read(f)));

describe('INV-SCAN: no header-based tenant code remains anywhere', () => {
  it('INV-SCAN-1 no non-test source under apps/*/src or packages/*/src names a tenant or admin header', () => {
    const files = srcFiles().filter((f) => !isTest(f));
    expect(files.length).toBeGreaterThan(30); // the walk found the repository, not an empty dir
    expect(hits(files, HEADER_NAMES)).toEqual([]);
  });

  // Mutation: an app imports TenancyModule / TENANT_RESOLVER and wires its own resolver.
  it('INV-SCAN-2 no app wires tenancy itself: apps use ServiceAuthModule.forService, nothing else', () => {
    const appSources = srcFiles().filter((f) => f.startsWith('apps/') && !isTest(f));
    expect(hits(appSources, /TenancyModule|TENANT_RESOLVER|TenantResolver|TenantGuard\b/)).toEqual(
      [],
    );
    const mains = appSources.filter((f) => /app\.module\.ts$/.test(f));
    expect(mains.length).toBe(3); // identity, payments, engagement
    for (const f of mains) expect(read(f)).toContain('ServiceAuthModule.forService(');
  });

  // Mutation: leave a foundation test (or the shared env) pinning the placeholder.
  //
  // int/all review: the scan reads CODE, not comments (a comment that says "there is no x-tenant-id
  // header" pins nothing), and the exceptions are exact paths, each with the reason it is allowed:
  // the file SENDS a forged header and asserts that it is ignored or refused. A basename list let
  // any future file called `auth.test.ts` or `wiring.test.ts` through. An entry whose file no
  // longer matches is stale and fails the test, so the list cannot silently outlive its reason.
  // Mutations: put `'x-tenant-id': t` in the headers of a compose helper (tests/compose/src/env.ts),
  // or add a new test file that sends `x-sandbox` -> red until it is listed here with a reason.
  it('INV-SCAN-3 no foundation test or compose helper still pins the header placeholder (F15)', () => {
    const NEGATIVE_ON_PURPOSE: Record<string, string> = {
      'packages/service-kit/src/service-auth.test.ts':
        'the entry point: a forged x-tenant-id / x-principal-* is ignored, the token decides (D-4)',
      'packages/service-kit/src/auth.test.ts':
        'the verifier: forged tenant headers never reach the auth context (D-4)',
      'packages/service-kit/src/no-header-tenant.test.ts': 'this scan: it names the patterns',
      'apps/identity/src/identity.http.test.ts':
        'identity routes ignore a forged tenant header (D-4)',
      'tests/compose/src/identity.compose.test.ts':
        'the real stack ignores a forged x-tenant-id in every service (D-4)',
      'apps/payments/src/acting-ban.test.ts':
        'INV-ACTBAN-6: an x-acting-tenant header changes nothing, the act claim decides (D-5)',
      'apps/payments/src/coin-action.test.ts':
        'the coin-action route probe sends x-acting-tenant and asserts the claim decides (D-5)',
      'apps/payments/src/controllers/operator-plan.controller.test.ts':
        'GET /v1/operator/plan: a forged x-tenant-id naming another tenant changes nothing (D-4, D-27)',
      'apps/payments/src/controllers/coins.controller.test.ts':
        'x-sandbox: 0 on a sandbox token still reads the sandbox wallet (X-2, D-13)',
      'apps/engagement/src/controllers/ingest.controller.test.ts':
        'a webhook with x-sandbox: 1 on a production credential stays production (D-13, X-3)',
      'apps/engagement/src/controllers/spin.controller.test.ts':
        'INV-SPIN-SANDBOX-CLAIM: x-sandbox on a production token is ignored (D-13)',
      'apps/engagement/src/controllers/store.controllers.test.ts':
        'I-API-5: forged x-sandbox / x-principal-id / x-tenant-id are ignored (X-3, X-9)',
      'apps/engagement/src/services/ingestion.service.test.ts':
        'a client x-sandbox hint does not turn the flag on for a production credential (D-13)',
    };
    const FORBIDDEN =
      /x-tenant-id|x-principal-|x-platform-admin-token|x-service-id|x-service-token|x-acting-tenant|x-sandbox|PLATFORM_TOKEN|headerTenantResolver|TenancyModule\.forRoot/i;
    // Comments do not pin anything: drop block comments and `//` comments (not the `//` of a URL).
    const code = (rel: string) =>
      read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1');
    const candidates = [...srcFiles(), ...walk('tests/compose/src')].filter(
      (f) => isTest(f) || f.startsWith('tests/'),
    );
    expect(candidates.length).toBeGreaterThan(30); // the walk found the repository
    const matching = candidates.filter((f) => FORBIDDEN.test(code(f)));
    expect(matching.filter((f) => !(f in NEGATIVE_ON_PURPOSE))).toEqual([]);
    // every exception still exists and still needs to be one (no stale entry keeps a door open)
    const stale = Object.keys(NEGATIVE_ON_PURPOSE).filter((f) => !matching.includes(f));
    expect(stale).toEqual([]);
  });

  // Mutation: restore PLATFORM_ADMIN_TOKEN in compose/deploy, or ship identity without its keys.
  it('INV-SCAN-4 compose, deploy and env examples have no platform token and carry the identity secrets', () => {
    const cfg = ['docker-compose.yml', '.deckhand/deploy.yml', 'apps/identity/.env.example'];
    for (const f of cfg)
      expect(read(f)).not.toMatch(/PLATFORM_ADMIN_TOKEN|x-platform-admin-token/i);
    expect(read('docker-compose.yml')).toContain('CREDENTIALS_KEK');
    expect(read('.deckhand/deploy.yml')).toContain('CREDENTIALS_KEK');
    expect(read('apps/identity/.env.example')).toContain('CREDENTIALS_KEK');
    // service-to-service client credentials (D-4): identity holds the registry, callers hold their own secret
    expect(read('apps/identity/.env.example')).toContain('SERVICE_CLIENT_SECRETS');
    for (const f of ['apps/engagement/.env.example', 'apps/payments/.env.example']) {
      expect(read(f)).toContain('SERVICE_CLIENT_SECRET');
    }
    expect(read('docker-compose.yml')).toContain('SERVICE_CLIENT_SECRET');
    expect(read('.deckhand/deploy.yml')).toContain('SERVICE_CLIENT_SECRET');
  });
});
