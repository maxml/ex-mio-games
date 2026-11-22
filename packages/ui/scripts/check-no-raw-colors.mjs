// Fails if any source file of packages/ui or apps/web, other than the token file (src/tokens.css)
// and the tenant themes (src/theme/), contains a raw colour:
//   - hex, rgb(), hsl(), oklch(), oklab()
//   - a Tailwind palette colour class (bg-red-500, text-[#fff], ...)
//   - a CSS named colour used as a colour value: in style props / objects (`color: 'red'`),
//     in .css declarations (`background: white;`) and in SVG colour attributes (`fill="red"`)
//   - any string literal in .ts/.tsx that is exactly a CSS named colour (`const ALERT = 'crimson'`)
// No line can opt out: the old `allow-raw-color` comment escape is gone.
// Components must use tokens (`var(--fg)`, `bg-surface`, ...).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = [
  join(root, 'src'),
  join(root, '../../apps/web/app'),
  join(root, '../../apps/web/src'),
];
const ALLOWED_DIR = join(root, 'src/theme');
const ALLOWED_FILE = join(root, 'src/tokens.css');

// CSS Color Module named colours. `transparent` and `currentcolor` are not palette colours: allowed.
const NAMED = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

const RAW = [
  /#[0-9a-fA-F]{3,8}\b(?![-\w])/, // hex colour
  /\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/,
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|shadow)-(?:red|green|blue|yellow|amber|orange|purple|violet|indigo|pink|rose|teal|cyan|emerald|lime|sky|slate|gray|zinc|neutral|stone|fuchsia|white|black)(?:-\d{2,3})?\b/,
  /\b(?:bg|text|border|fill|stroke)-\[#/,
];

// property: value pairs in object literals (style props) and CSS declarations.
const COLOR_PROP =
  /\b(?:color|background|background-?[cC]olor|fill|stroke|border|border-?[cC]olor|outline|outline-?[cC]olor|box-?[sS]hadow|text-?[sS]hadow|accent-?[cC]olor|caret-?[cC]olor|stop-?[cC]olor|flood-?[cC]olor)['"]?\s*:\s*([^;}]+)/g;
// SVG / JSX colour attributes: fill="red".
const COLOR_ATTR = /\b(?:fill|stroke|color|stop-color|flood-color)=\{?["'`]([^"'`]+)["'`]/g;

function namedColourIn(value) {
  for (const w of value.toLowerCase().match(/[a-z]+/g) ?? []) if (NAMED.has(w)) return w;
  return null;
}
function namedColour(line) {
  for (const m of line.matchAll(COLOR_PROP)) {
    // A value is only a colour if it is a bare word or a quoted literal, not `var(--x)` / a call.
    const value = m[1].replace(/var\([^)]*\)/g, '').replace(/\b[a-z]+\([^)]*\)/gi, '');
    const hit = namedColourIn(value);
    if (hit) return hit;
  }
  for (const m of line.matchAll(COLOR_ATTR)) {
    const hit = namedColourIn(m[1].replace(/var\([^)]*\)/g, ''));
    if (hit) return hit;
  }
  return null;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|css)$/.test(name)) yield p;
  }
}

const hits = [];
for (const file of ROOTS.filter(existsSync).flatMap((r) => [...walk(r)])) {
  if (file.startsWith(ALLOWED_DIR) || file === ALLOWED_FILE) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      // There is no escape comment: a line cannot opt out of the gate.
      const where = `${relative(root, file)}:${i + 1}: ${line.trim()}`;
      for (const re of RAW) if (re.test(line)) hits.push(where);
      const named = namedColour(line);
      if (named) hits.push(`${where}   <- named colour "${named}"`);
      // A named colour held in a constant (`const ALERT = 'crimson'`) is caught by the literal itself.
      if (/\.tsx?$/.test(file)) {
        for (const m of line.matchAll(/(['"`])\s*([A-Za-z]+)\s*\1/g)) {
          if (NAMED.has(m[2].toLowerCase()))
            hits.push(`${where}   <- string literal that is a named colour "${m[2]}"`);
        }
      }
    });
}
if (hits.length) {
  console.error(
    `Raw colours outside the token file and src/theme/ (use tokens):\n${hits.join('\n')}`,
  );
  process.exit(1);
}
console.log('ok   no raw or named colours outside src/theme/');
