import { defineConfig } from 'steiger';
import fsd from '@feature-sliced/steiger-plugin';

// Steiger enforces the *structural* side of Feature-Sliced Design (public APIs,
// slice/segment shape, layer naming) — complementary to the ESLint
// `import/no-restricted-paths` rule in apps/web/.eslintrc.cjs, which enforces the
// *import-direction* dependency rule. Run with `pnpm lint:fsd`.
//
// The FSD root is apps/web/src/layers (ADR-0005 §3.1 Variant A: the Next `app/`
// directory stays routes-only, and the FSD `pages` layer is renamed `views`).
export default defineConfig([
  ...fsd.configs.recommended,
  {
    // Storybook stories and colocated unit/component tests live next to their
    // `shared/ui` / feature components but are dev-only tooling, not part of the
    // FSD slice graph — exclude them so they don't trip the public-API / segment
    // heuristics. (The MSW handlers + Playwright e2e live under apps/web/src/test
    // and apps/web/e2e, outside steiger's apps/web/src/layers root.)
    ignores: ['**/*.stories.@(ts|tsx)', '**/*.test.@(ts|tsx)'],
  },
  {
    // ADR-0001 §7 mandates a `shared/types` segment that re-exports
    // `@ex-mio/contracts`. That name is "by contents", which trips
    // steiger's `segments-by-purpose` heuristic — but the ADR is the source of
    // truth for this skeleton, so silence that one rule on the shared layer.
    files: ['apps/web/src/layers/shared/**'],
    rules: {
      'fsd/segments-by-purpose': 'off',
    },
  },
  {
    // `insignificant-slice` flags slices with too few inbound references. Under
    // ADR-0005 §3.1 Variant A the real consumers are the Next route files in
    // `apps/web/app/**`, which live *outside* steiger's `apps/web/src/layers`
    // root — so steiger's reference graph is rooted at the `views` layer and can
    // never observe a widget/feature/entity actually being used. The heuristic
    // therefore false-positives on every legitimately-used non-entry slice
    // (e.g. the `api-health` client island, ADR-0005 §4.1). Disable it for those
    // layers; the load-bearing FSD rules — import direction (ESLint
    // `import/no-restricted-paths`) and per-slice Public API — stay enforced.
    files: [
      'apps/web/src/layers/widgets/**',
      'apps/web/src/layers/features/**',
      'apps/web/src/layers/entities/**',
    ],
    rules: {
      'fsd/insignificant-slice': 'off',
    },
  },
]);
