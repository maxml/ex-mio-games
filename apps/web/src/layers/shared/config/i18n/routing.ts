import { defineRouting } from 'next-intl/routing';

// Single source of truth for the app's locales and routing strategy (ADR-0005 §6:
// next-intl on web). `localePrefix` defaults to `'always'`, so every URL is
// locale-prefixed (`/en`, `/uk`) and `/` redirects to the default locale — the
// SEO-friendly, idiomatic next-intl App Router setup (see this segment's
// `index.ts` for the SEED rationale).
//
// SEED: two locales only. The real translation source (a Loco/next-intl export)
// is app-specific and out of scope here — wire your translation export to the
// `./messages/*.json` catalogs in a follow-up.
export const routing = defineRouting({
  locales: ['en', 'uk'],
  defaultLocale: 'en',
});

export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;
export type Locale = (typeof routing.locales)[number];
