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
  /x-tenant-id|x-principal-id|x-platform-admin-token|HEADER_TENANT_ID|HEADER_PLATFORM_TOKEN|TENANT_HEADER|PRINCIPAL_HEADER|headerTenantResolver|PLATFORM_ADMIN_TOKEN|PlatformAdminGuard/i;

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
  it('INV-SCAN-3 no foundation test or compose helper still pins the header placeholder (F15)', () => {
    const NEGATIVE_ON_PURPOSE = [
      'service-auth.test.ts',
      'auth.test.ts',
      'no-header-tenant.test.ts',
      'identity.http.test.ts',
      'identity.compose.test.ts',
      'acting-ban.test.ts',
      'wiring.test.ts',
    ];
    const files = [...srcFiles(), ...walk('tests/compose/src')].filter(
      (f) =>
        (isTest(f) || f.startsWith('tests/')) &&
        !NEGATIVE_ON_PURPOSE.some((n) => f.endsWith(`/${n}`)),
    );
    expect(
      hits(
        files,
        /x-tenant-id|x-principal-id|x-platform-admin-token|PLATFORM_TOKEN|headerTenantResolver|TenancyModule\.forRoot/i,
      ),
    ).toEqual([]);
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
