// A-UI-1 (operator IA spec, section 5; T4 guard, prototype copy). Written by the test author from the spec.
//
// Scope (the spec's glob): design/prototype/src/screens/**/*.tsx. The spec's violation allow-list starts
// EMPTY, and so does this one. Separately, and outside that glob, the T4 brief also guards the app shell
// src/App.tsx (see the last describe block); it is reported apart so the spec's scope stays exact.
//
// Rules, per scanned file:
//   (a) UI comes only from `@ex-mio/ui`. A package import must be one of NON_UI_PACKAGES. A relative import
//       that is not itself a scanned file is followed (with its own relative imports) and must carry no
//       markup: no intrinsic JSX, no `className=`, no `createElement('tag')`, no stylesheet.
//   (b) no intrinsic JSX element. The spec's regex `<[a-z][a-z0-9]*[\s/>]` is applied to the source of
//       every JSX tag (so a generic such as `useState<string>` is not mistaken for markup); a tag whose
//       name starts lower-case or holds a `-` is intrinsic too, which is how TypeScript decides it.
//   (c) no `className=` prop.
//
// Mutation that must turn this red (re-applied by the test author, see the hand-off):
//   add `<div className="grid">` (with a closing tag) to the JSX of src/screens/operator/StoreScreen.tsx
//   -> "src/screens/operator/StoreScreen.tsx is built only from @ex-mio/ui" fails with (b) and (c).
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Every script under src, as text, keyed `src/...`. Vite reads them; the prototype has no node types. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
  ).map(([k, v]) => [`src/${k.slice(2)}`, v]),
);

const UI_SOURCES = new Set(['@ex-mio/ui']);
/** Packages that bring logic, never markup. Anything else is a UI source: red. */
const NON_UI_PACKAGES = new Set(['react']);

interface Violation {
  line: number;
  rule: '(a)' | '(b)' | '(c)';
  detail: string;
}

interface ImportRef {
  spec: string;
  line: number;
}

const INTRINSIC_REGEX = /^<[a-z][a-z0-9]*[\s/>]/; // section 5, rule (b), verbatim

/** Rules (b) and (c), plus the import list for rule (a). Pure: text in, findings out. */
function scanSource(file: string, text: string): { found: Violation[]; imports: ImportRef[] } {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: Violation[] = [];
  const imports: ImportRef[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const name = n.tagName.getText(sf);
      const src = text.slice(n.getStart(sf), n.getEnd());
      if (
        INTRINSIC_REGEX.test(src) ||
        (ts.isIdentifier(n.tagName) && /^[a-z]/.test(name)) ||
        name.includes('-')
      ) {
        found.push({ line: lineOf(n), rule: '(b)', detail: `intrinsic <${name}>` });
      }
    }
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === 'className') {
      found.push({ line: lineOf(n), rule: '(c)', detail: 'className= prop' });
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const [first] = n.arguments;
      if (/(^|\.)createElement$/.test(callee) && first && ts.isStringLiteralLike(first)) {
        found.push({ line: lineOf(n), rule: '(b)', detail: `createElement('${first.text}')` });
      }
      if (
        (n.expression.kind === ts.SyntaxKind.ImportKeyword || callee === 'require') &&
        first &&
        ts.isStringLiteralLike(first)
      ) {
        imports.push({ spec: first.text, line: lineOf(n) });
      }
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const typeOnly =
        !!c &&
        (c.isTypeOnly ||
          (!c.name &&
            !!c.namedBindings &&
            ts.isNamedImports(c.namedBindings) &&
            c.namedBindings.elements.length > 0 &&
            c.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) imports.push({ spec: n.moduleSpecifier.text, line: lineOf(n) });
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.isTypeOnly) imports.push({ spec: n.moduleSpecifier.text, line: lineOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { found, imports };
}

type Overlay = Record<string, string>;

/** POSIX join of a directory and a relative specifier (`src/screens/operator` + `../../router`). */
function joinRel(dir: string, spec: string): string {
  const parts = dir.split('/');
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** A relative specifier to a `src/...` key; null for a package. */
function resolveInternal(from: string, spec: string, overlay: Overlay = {}): string | null {
  if (!spec.startsWith('.')) return null;
  const base = joinRel(from.split('/').slice(0, -1).join('/'), spec);
  const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e);
  return hit.find((p) => p in overlay || p in SOURCES) ?? `${base} (unresolved)`;
}

const read = (f: string, overlay: Overlay = {}) => overlay[f] ?? SOURCES[f];

/** Markup inside a non-scanned module and its relative imports (rule (a), followed). */
function markupBehind(start: string, scanned: Set<string>, overlay: Overlay = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f) || scanned.has(f)) continue;
    seen.add(f);
    if (f.endsWith('(unresolved)')) {
      out.push(`${f}: cannot be resolved (stylesheet, asset or missing module)`);
      continue;
    }
    const { found, imports } = scanSource(f, read(f, overlay));
    for (const v of found) out.push(`${f}:${v.line} ${v.detail}`);
    for (const i of imports) {
      if (UI_SOURCES.has(i.spec)) continue;
      const next = resolveInternal(f, i.spec, overlay);
      if (next) queue.push(next);
    }
  }
  return out;
}

function checkFile(file: string, scanned: Set<string>, overlay: Overlay = {}): string[] {
  const { found, imports } = scanSource(file, read(file, overlay));
  const out = found.map((v) => `${file}:${v.line} ${v.rule} ${v.detail}`);
  for (const i of imports) {
    if (UI_SOURCES.has(i.spec)) continue;
    const internal = resolveInternal(file, i.spec, overlay);
    if (internal === null) {
      if (!NON_UI_PACKAGES.has(i.spec)) {
        out.push(`${file}:${i.line} (a) '${i.spec}' is neither @ex-mio/ui nor a non-UI package`);
      }
      continue;
    }
    for (const m of markupBehind(internal, scanned, overlay)) {
      out.push(`${file}:${i.line} (a) markup reached through '${i.spec}': ${m}`);
    }
  }
  return out;
}

/** The spec glob `design/prototype/src/screens/**\/*.tsx`. */
const FILES = Object.keys(SOURCES)
  .filter((f) => f.startsWith('src/screens/') && f.endsWith('.tsx'))
  .sort();
const SCANNED = new Set(FILES);

describe('A-UI-1 guard mechanics (the checker itself)', () => {
  it('scans the spec glob: every screen file', () => {
    // A literal list, not derived from the scan: a broken glob that finds nothing cannot pass.
    const mustScan = [
      'src/screens/AdminConsole.tsx',
      'src/screens/PlayerWidget.tsx',
      'src/screens/operator/shell.tsx',
      'src/screens/operator/SetupScreen.tsx',
      'src/screens/operator/RulesScreen.tsx',
      'src/screens/operator/WheelScreen.tsx',
      'src/screens/operator/StoreScreen.tsx',
      'src/screens/operator/RedemptionsScreen.tsx',
      'src/screens/operator/InsightsScreen.tsx',
      'src/screens/operator/TeamScreen.tsx',
    ];
    for (const f of mustScan) expect(SCANNED.has(f), f).toBe(true);
    expect(SCANNED.has('src/App.tsx')).toBe(false);
    expect(SOURCES['src/App.tsx']).toContain('export function App');
  });

  it('flags the spec mutation `<div className="grid">` under rules (b) and (c)', () => {
    const { found } = scanSource(
      'X.tsx',
      'import { Card } from \'@ex-mio/ui\';\nexport const X = () => (\n  <Card>\n    <div className="grid">x</div>\n  </Card>\n);\n',
    );
    expect(found.map((v) => `${v.line} ${v.rule}`).sort()).toEqual(['4 (b)', '4 (c)']);
  });

  it('does not take generics or comments for markup, and does take createElement and custom tags', () => {
    const clean = scanSource(
      'Y.tsx',
      '// <div> in a comment\nimport { useState } from \'react\';\nexport function Y() {\n  const [a] = useState<string | null>(null);\n  const b: Array<number> = [];\n  return <Stack gap="2">{a}{b.length}</Stack>;\n}\n',
    );
    expect(clean.found).toEqual([]);
    const dirty = scanSource(
      'Z.tsx',
      "import { createElement } from 'react';\nexport const Z = () => createElement('section', null, <my-el />);\n",
    );
    expect(dirty.found.map((v) => v.rule)).toEqual(['(b)', '(b)']);
  });

  it('rule (a): a UI package other than @ex-mio/ui is reported; a type-only import is not', () => {
    const fake = 'src/screens/operator/Fake.tsx';
    const out = checkFile(fake, SCANNED, {
      [fake]:
        "import { Link } from 'some-ui-kit';\nimport type { NavPage } from 'other-kit';\nimport { type A, type B } from 'third-kit';\nimport { Button } from '@ex-mio/ui';\nimport { useState } from 'react';\n",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(":1 (a) 'some-ui-kit'");
  });

  it('rule (a): markup behind a relative helper (two hops) is reported; so is a stylesheet', () => {
    const fake = 'src/screens/operator/Fake.tsx';
    const out = checkFile(fake, SCANNED, {
      // Line 1: scanned on its own, not followed. Line 2: a .ts barrel that re-exports a .tsx with a
      // styled div. Line 3: a stylesheet, which no screen may bring in.
      [fake]:
        "import { useOperatorShell } from './shell';\nimport { Wrapper } from '../../lib/fake-barrel';\nimport './fake.css';\n",
      'src/lib/fake-barrel.ts': "export { Wrapper } from './FakeWrapper';\n",
      'src/lib/FakeWrapper.tsx': 'export const Wrapper = () => <div className="grid" />;\n',
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/:2 \(a\) markup reached through .*FakeWrapper.tsx:1 intrinsic <div>/);
    expect(out[1]).toMatch(/:2 \(a\) markup reached through .*FakeWrapper.tsx:1 className/);
    expect(out[2]).toContain(":3 (a) markup reached through './fake.css'");
  });
});

describe('A-UI-1: prototype screens are built only from @ex-mio/ui', () => {
  for (const file of FILES) {
    it(`${file} is built only from @ex-mio/ui`, () => {
      expect(checkFile(file, SCANNED)).toEqual([]);
    });
  }
});

describe('A-UI-1 (T4 brief, outside the section 5 glob): the prototype app shell', () => {
  // Was red: src/App.tsx rendered a raw `<main className>`. It now uses the @ex-mio/ui `Main` landmark.
  it('src/App.tsx is built only from @ex-mio/ui', () => {
    expect(checkFile('src/App.tsx', SCANNED)).toEqual([]);
  });
});
