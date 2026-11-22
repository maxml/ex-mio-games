import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IDENTITY_ERRORS, PAYMENTS_ERROR_CODES, STORE_ERROR_CODES } from '@ex-mio/contracts';

/*
 * Final review (question 4, D-26 INV-AUD): "policy checks signal through one typed error
 * (AuthorizationRefused)". The entry point maps only that class to `refused`; INV-AUD-A1 pins that
 * a plain 403 from a handler is audited `allowed`. So an in-service refusal built from a domain
 * error with a 403 code is invisible to the audit by construction, and nothing else finds it:
 * the INV-AUD-MATRIX walk only sees refusals that an acting or service caller can reach.
 *
 * This scan is the choke point for the RULE: every 403 thrown outside a guard in identity,
 * engagement and payments is an AuthorizationRefused, or is listed below with its reason.
 *
 * RED at a4d97bb: the offenders are printed by AUD-SCAN-1.
 * Mutation (re-applied in the review): access.service.ts throws `new IdentityError('FORBIDDEN')`
 * again for the final `can()` refusal -> AUD-SCAN-1 names access.service.ts.
 */

const ROOT = resolve(__dirname, '../../..');
const SERVICES = ['apps/identity/src', 'apps/engagement/src', 'apps/payments/src'];

const walk = (dir: string): string[] => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
};
const isProd = (f: string): boolean =>
  f.endsWith('.ts') &&
  !/\.(test|spec|itest|pgtest)\.ts$/.test(f) &&
  !/\.pg\.itest\.ts$/.test(f) &&
  !f.includes('/testing/') &&
  !f.includes('/migrations/');

/** Every domain error code that maps to 403, in any service's code table. */
const FORBIDDEN_CODES = new Set(
  [IDENTITY_ERRORS, PAYMENTS_ERROR_CODES, STORE_ERROR_CODES].flatMap((table) =>
    Object.entries(table as Record<string, number>)
      .filter(([, status]) => status === 403)
      .map(([code]) => code),
  ),
);

/** Comments dropped, newlines kept, so a hit's line number is the file's. */
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1');

/** `file:line  snippet` for each 403 refusal that is not the typed error. */
export function untypedRefusals(rel: string, src: string): string[] {
  const body = code(src);
  // A guard's refusal is a guard refusal (D-24), already `refused`: not this rule.
  if (/implements\s+CanActivate\b/.test(body)) return [];
  const hits: string[] = [];
  const at = (index: number, what: string) =>
    hits.push(`${rel}:${body.slice(0, index).split('\n').length}  ${what}`);
  for (const m of body.matchAll(/new\s+(\w+Error)\(\s*['"]([A-Za-z_]+)['"]/g)) {
    if (FORBIDDEN_CODES.has(m[2]!)) at(m.index!, `${m[1]}('${m[2]}')`);
  }
  for (const m of body.matchAll(/new\s+ForbiddenException\(/g)) at(m.index!, 'ForbiddenException');
  for (const m of body.matchAll(/new\s+HttpException\([\s\S]{0,200}?,\s*403\s*\)/g))
    at(m.index!, 'HttpException(..., 403)');
  return hits;
}

/**
 * Exceptions, each with the reason it is not an authorization refusal. Empty at the review: the
 * coordinator decides each RED site (type it, or list it here with a reason).
 */
const NOT_AUTHORIZATION: Record<string, string> = {};

describe('final review: every in-service 403 is an AuthorizationRefused (D-26 INV-AUD)', () => {
  it('AUD-SCAN-0 the rule matches its own samples and not the typed error', () => {
    expect(
      untypedRefusals('x.ts', `throw new IdentityError('ACTING_FORBIDDEN', 'm')`),
    ).toHaveLength(1);
    expect(untypedRefusals('x.ts', `throw new SagaError(\n  'forbidden')`)).toHaveLength(1);
    expect(untypedRefusals('x.ts', `throw new LedgerError('forbidden', 'm')`)).toHaveLength(1);
    expect(untypedRefusals('x.ts', `throw new HttpException({ code: 'x' }, 403)`)).toHaveLength(1);
    expect(untypedRefusals('x.ts', `throw new ForbiddenException()`)).toHaveLength(1);
    expect(untypedRefusals('x.ts', `throw new IdentityError('NOT_FOUND')`)).toHaveLength(0);
    expect(
      untypedRefusals('x.ts', `throw new AuthorizationRefused({ code: 'FORBIDDEN' })`),
    ).toHaveLength(0);
    expect(
      untypedRefusals(
        'g.ts',
        `class G implements CanActivate { x() { throw new SagaError('forbidden') } }`,
      ),
    ).toHaveLength(0);
    expect(FORBIDDEN_CODES.has('TENANT_SUSPENDED')).toBe(true);
  });

  it('AUD-SCAN-1 no service throws a 403 outside a guard except through AuthorizationRefused', () => {
    const files = SERVICES.flatMap(walk).filter(isProd);
    expect(files.length).toBeGreaterThan(50); // the walk found the services
    const offenders = files
      .flatMap((f) => untypedRefusals(f, readFileSync(join(ROOT, f), 'utf8')))
      .filter((hit) => !Object.keys(NOT_AUTHORIZATION).some((k) => hit.startsWith(`${k}:`)));
    expect(offenders).toEqual([]);
  });

  it('AUD-SCAN-2 every listed exception still matches a site (no stale entry)', () => {
    for (const rel of Object.keys(NOT_AUTHORIZATION)) {
      const file = rel.split(':')[0]!;
      expect(untypedRefusals(file, readFileSync(join(ROOT, file), 'utf8')).length).toBeGreaterThan(
        0,
      );
    }
  });
});
