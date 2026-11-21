// Fails if any source file outside src/theme/ contains a raw colour (hex, rgb(), hsl(), oklch())
// or a Tailwind palette colour class (bg-red-500, text-[#fff], ...). Components must use tokens.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const ALLOWED_DIR = join(src, 'theme');

const RAW = [
  /#[0-9a-fA-F]{3,8}\b(?![-\w])/, // hex colour
  /\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/,
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|shadow)-(?:red|green|blue|yellow|amber|orange|purple|violet|indigo|pink|rose|teal|cyan|emerald|lime|sky|slate|gray|zinc|neutral|stone|fuchsia|white|black)(?:-\d{2,3})?\b/,
  /\b(?:bg|text|border|fill|stroke)-\[#/,
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|css)$/.test(name)) yield p;
  }
}

const hits = [];
for (const file of walk(src)) {
  if (file.startsWith(ALLOWED_DIR)) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes('allow-raw-color')) return;
      for (const re of RAW) if (re.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
}
if (hits.length) {
  console.error(`Raw colours outside src/theme/ (use tokens):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('ok   no raw colours outside src/theme/');
