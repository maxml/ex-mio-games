import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * Reviewer test (identity epic review, L1 Stage B finding M2): a controller parses the CONTRACT
 * schema itself. The Stage B coder forked `OperatorSignupRequest` with a local
 * `SignupBody = OperatorSignupRequest.extend({ slug: ...min(1) })`, so the server accepted what the
 * web client's copy of the contract refused. Patching that one call site does not stop the next
 * fork; this scan covers every controller of every app.
 *
 * Choke point: the repository. A controller is any non-test source under apps/<app>/src that
 * declares `@Controller(`.
 *
 * Mutation (PARITY-1): add `const SignupBody = OperatorSignupRequest.extend({...})` (or `.merge`,
 * `.omit`, `.pick`, `.partial`, `...X.shape`) to any controller file.
 * Mutation (PARITY-2): parse a request body with a schema declared in the controller file.
 */

const ROOT = resolve(__dirname, '../../..');

const walk = (dir: string): string[] => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true }) as string[])
    .map((p) => join(dir, p))
    .filter((p) => /\.ts$/.test(p) && !/(^|\/)(node_modules|dist)\//.test(p));
};

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const isTest = (rel: string) => /\.test\.ts$/.test(rel) || /(^|\/)testing\//.test(rel);

const controllers = (): string[] =>
  readdirSync(join(ROOT, 'apps'))
    .flatMap((app) => walk(join('apps', app, 'src')))
    .filter((f) => !isTest(f) && /@Controller\(/.test(read(f)));

/** Value names a file imports from `@ex-mio/contracts` (type-only imports excluded). */
const contractImports = (src: string): string[] => {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*'@ex-mio\/contracts'/g)) {
    if (m[1]) continue;
    for (const part of (m[2] ?? '').split(',')) {
      const p = part.trim();
      if (!p || p.startsWith('type ')) continue;
      names.push((p.split(/\s+as\s+/).pop() ?? p).trim());
    }
  }
  return names;
};

const DERIVE =
  /\.(extend|merge|omit|pick|partial|deepPartial|required|passthrough|strip|catchall|and|or|refine|superRefine|transform|pipe|shape)\b/;

describe('PARITY: controllers parse the contract schemas, never a local fork of them', () => {
  it('PARITY-0 the scan finds the identity controllers', () => {
    const found = controllers();
    expect(found).toEqual(
      expect.arrayContaining(['apps/identity/src/controllers/identity.controllers.ts']),
    );
  });

  it('PARITY-1 no controller derives a schema from a contract (.extend, .merge, .omit, .pick, .partial, .shape, ...)', () => {
    const forks: string[] = [];
    for (const file of controllers()) {
      const src = read(file);
      for (const name of contractImports(src)) {
        const re = new RegExp(`\\b${name}${DERIVE.source}`);
        const line = src.split('\n').findIndex((l) => re.test(l));
        if (line >= 0) forks.push(`${file}:${line + 1} ${name}`);
      }
    }
    expect(forks).toEqual([]);
  });

  // A request body is an HTTP shape: it lives in packages/contracts (AGENTS.md), where the web
  // client reads the same schema. Path params may stay local.
  it('PARITY-2 every request body is parsed with a schema imported from @ex-mio/contracts', () => {
    const local: string[] = [];
    for (const file of controllers()) {
      const src = read(file);
      const imported = new Set(contractImports(src));
      for (const m of src.matchAll(/parseInput\(\s*([A-Za-z_$][\w$]*)\s*,\s*body\b/g)) {
        const name = m[1] ?? '';
        if (!imported.has(name)) {
          const line = src.slice(0, m.index ?? 0).split('\n').length;
          local.push(`${file}:${line} ${name}`);
        }
      }
    }
    expect(local).toEqual([]);
  });
});
