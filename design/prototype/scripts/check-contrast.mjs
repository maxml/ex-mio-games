// Contrast gate: every theme (default + each tenant override) must meet WCAG AA for the token
// pairs the components actually render. Run by `build`; a failing tenant theme fails the build.
//
// Two checks per theme:
//   1. Shape: the theme JSON is validated against src/theme/tenant-theme.schema.json (unknown
//      token names, malformed values and unknown top-level keys fail; a typo never passes silently).
//   2. Contrast: every pair in PAIRS, resolved against tokens.css defaults plus the overrides.
//
// Usage: node scripts/check-contrast.mjs [extra-theme.json ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/theme/tokens.css'), 'utf8');
const schema = JSON.parse(readFileSync(join(root, 'src/theme/tenant-theme.schema.json'), 'utf8'));

const defaults = {};
for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) defaults[m[1]] = m[2].trim();

// [foreground, background, minimum ratio, what it is]
// 4.5 = body text; 3 = large text, icons and UI boundaries (WCAG 1.4.11).
export const PAIRS = [
  ['fg', 'bg', 4.5, 'body text on page'],
  ['fg', 'surface', 4.5, 'body text on card'],
  ['fg', 'surface-2', 4.5, 'body text on inset'],
  ['fg-muted', 'surface', 4.5, 'secondary text on card'],
  ['fg-muted', 'surface-2', 4.5, 'secondary text on inset'],
  ['fg-muted', 'bg', 4.5, 'secondary text on page'],
  ['primary-fg', 'primary', 4.5, 'primary button label'],
  ['accent-fg', 'accent', 4.5, 'accent button label'],
  ['primary', 'surface', 3, 'primary as link / outline on card'],
  ['ring', 'surface', 3, 'focus ring on card'],
  ['ring', 'surface-2', 3, 'focus ring on inset'],
  ['ring', 'bg', 3, 'focus ring on page'],
  ['input-border', 'surface', 3, 'form-field border on card'],
  ['input-border', 'surface-2', 3, 'form-field border on inset'],
  ['input-border', 'bg', 3, 'form-field border on page'],
  ['wheel-rim', 'bg', 3, 'wheel rim on page'],
  ['wheel-rim', 'surface', 3, 'wheel rim on card'],
  ['success', 'surface', 4.5, 'status text: success'],
  ['warning', 'surface', 4.5, 'status text: warning'],
  ['danger', 'surface', 4.5, 'status text: danger'],
  ['info', 'surface', 4.5, 'status text: info'],
  ['coin', 'surface', 3, 'coin icon on card'],
  ...[1, 2, 3, 4, 5, 6].map((i) => ['wheel-fg', `wheel-${i}`, 4.5, `wheel label on segment ${i}`]),
];

function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Minimal validator for the subset of JSON Schema the tenant schema uses. Returns error strings. */
function validateShape(theme) {
  const errs = [];
  for (const k of schema.required) if (!(k in theme)) errs.push(`missing required key "${k}"`);
  for (const k of Object.keys(theme))
    if (!(k in schema.properties)) errs.push(`unknown top-level key "${k}"`);
  if (typeof theme.id === 'string' && !new RegExp(schema.properties.id.pattern).test(theme.id))
    errs.push(`id "${theme.id}" does not match ${schema.properties.id.pattern}`);
  const rules = Object.entries(schema.properties.tokens.patternProperties).map(([k, v]) => [
    new RegExp(k),
    v,
  ]);
  for (const [name, value] of Object.entries(theme.tokens ?? {})) {
    const rule = rules.find(([re]) => re.test(name));
    if (!rule) errs.push(`unknown token "${name}" (not in the schema)`);
    else if (!new RegExp(rule[1].pattern ?? '.*').test(String(value)))
      errs.push(`token "${name}": "${value}" does not match ${rule[1].pattern}`);
  }
  return errs;
}

const tenantDir = join(root, 'src/theme/tenants');
const themes = [{ id: 'default (tokens.css)', tokens: {} }];
const files = readdirSync(tenantDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => join(tenantDir, f));
files.push(...process.argv.slice(2));
for (const f of files) themes.push({ ...JSON.parse(readFileSync(f, 'utf8')), __file: f });

let failures = 0;
for (const theme of themes) {
  const bad = [];
  if (theme.__file) {
    const { __file, ...plain } = theme;
    for (const e of validateShape(plain)) bad.push(`  schema: ${e}`);
  }
  const t = { ...defaults, ...theme.tokens };
  for (const [fg, bg, min, what] of PAIRS) {
    if (!/^#[0-9a-fA-F]{6}$/.test(t[fg] ?? '') || !/^#[0-9a-fA-F]{6}$/.test(t[bg] ?? '')) {
      bad.push(
        `  ${what}: token --${fg} or --${bg} is missing or not a 6-digit hex (${t[fg]}, ${t[bg]})`,
      );
      continue;
    }
    const r = ratio(t[fg], t[bg]);
    if (!(r >= min))
      bad.push(`  ${what}: --${fg} ${t[fg]} on --${bg} ${t[bg]} = ${r.toFixed(2)} (need ${min})`);
  }
  if (bad.length) {
    failures += bad.length;
    console.error(`FAIL ${theme.id}\n${bad.join('\n')}`);
  } else {
    console.log(`ok   ${theme.id}: schema valid, ${PAIRS.length} pairs meet their WCAG minimum`);
  }
}
if (failures) {
  console.error(`\n${failures} failure(s). Fix the theme tokens before building.`);
  process.exit(1);
}
