const path = require('path');

// Absolute path to an FSD layer dir, so the boundary zones are independent of
// ESLint's cwd (root `nx run-many` vs. `next lint` in this project).
const layer = (name) => path.join(__dirname, 'src', 'layers', name);

// FSD layers, top -> bottom. Imports may only flow downward (ADR-0001 §3, §6):
//   app(Next routes) -> app -> views -> widgets -> features -> entities -> shared
// `import/no-restricted-paths` forbids a file in `target` from importing any
// `from` layer (a layer at or above it). The `@/*` -> `src/*` alias is resolved
// by eslint-import-resolver-typescript (configured by next/core-web-vitals via
// this project's tsconfig.json), so aliased imports are checked too.
//
// Note: this enforces the *layer* dependency rule. Public-API access and
// no-cross-slice-import-within-a-layer are enforced by Steiger (`pnpm lint:fsd`).
const LAYERS_TOP_TO_BOTTOM = ['app', 'views', 'widgets', 'features', 'entities', 'shared'];

const zones = LAYERS_TOP_TO_BOTTOM.flatMap((name, idx) => {
  const upper = LAYERS_TOP_TO_BOTTOM.slice(0, idx);
  if (upper.length === 0) return [];
  return [
    {
      target: layer(name),
      from: upper.map(layer),
      message: `FSD boundary: \`${name}\` may not import from an upper layer (imports flow downward only).`,
    },
  ];
});

module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'prettier'],
  plugins: ['@nx'],
  // ESLint ignores dot-directories by default; un-ignore `.storybook` so its
  // config files are linted (not flagged as "ignored") when passed explicitly,
  // e.g. by the lint-staged pre-commit hook.
  ignorePatterns: ['!.storybook'],
  rules: {
    '@nx/enforce-module-boundaries': [
      'error',
      {
        enforceBuildableLibDependency: false,
        allow: [],
        depConstraints: [
          {
            sourceTag: 'type:app',
            onlyDependOnLibsWithTags: ['type:lib'],
          },
          {
            sourceTag: 'scope:web',
            onlyDependOnLibsWithTags: ['scope:shared'],
          },
        ],
      },
    ],
    'import/no-restricted-paths': ['error', { zones }],
  },
  overrides: [
    {
      // MIO-123: screens are built from `@ex-mio/ui`. Only layout and structure wrappers may be raw
      // HTML (div, span, section, main, header, nav, ul/ol/li, dl, form, strong); every control, link,
      // heading, paragraph, table and image comes from the design system.
      files: ['app/**/*.{ts,tsx}', 'src/layers/{app,views,widgets,features,entities}/**/*.{ts,tsx}'],
      excludedFiles: ['**/*.test.{ts,tsx}'],
      rules: {
        'react/forbid-elements': [
          'error',
          {
            forbid: [
              'button', 'input', 'select', 'textarea', 'label', 'a', 'img', 'p',
              'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
            ].map((element) => ({
              element,
              message: `Use the matching component from @ex-mio/ui instead of a raw <${element}>.`,
            })),
          },
        ],
      },
    },
  ],
};
