// Contrast gate: every theme (default + each tenant override) must meet WCAG AA for the token
// pairs the components actually render. Run by `build`; a failing tenant theme fails the build.
// Usage: node scripts/check-contrast.mjs [extra-theme.json ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/theme/tokens.css'), 'utf8');

const defaults = {};
for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) defaults[m[1]] = m[2].trim();

// [foreground, background, minimum ratio, what it is]
// 4.5 = body text; 3 = large text, icons and UI boundaries (WCAG 1.4.11).
const PAIRS = [
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
  ['ring', 'bg', 3, 'focus ring on page'],
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

const tenantDir = join(root, 'src/theme/tenants');
const themes = [{ id: 'default (tokens.css)', tokens: {} }];
for (const f of readdirSync(tenantDir).filter((f) => f.endsWith('.json'))) {
  themes.push(JSON.parse(readFileSync(join(tenantDir, f), 'utf8')));
}
for (const f of process.argv.slice(2)) themes.push(JSON.parse(readFileSync(f, 'utf8')));

let failures = 0;
for (const theme of themes) {
  const t = { ...defaults, ...theme.tokens };
  const bad = [];
  for (const [fg, bg, min, what] of PAIRS) {
    const r = ratio(t[fg], t[bg]);
    if (!(r >= min)) bad.push(`  ${what}: --${fg} ${t[fg]} on --${bg} ${t[bg]} = ${r.toFixed(2)} (need ${min})`);
  }
  if (bad.length) {
    failures += bad.length;
    console.error(`FAIL ${theme.id}\n${bad.join('\n')}`);
  } else {
    console.log(`ok   ${theme.id}: ${PAIRS.length} pairs meet WCAG AA`);
  }
}
if (failures) {
  console.error(`\n${failures} contrast failure(s). Fix the theme tokens before building.`);
  process.exit(1);
}
