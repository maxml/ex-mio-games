import createMiddleware from 'next-intl/middleware';
import { routing } from '@/layers/shared/config';

// Next middleware lives at the app root (framework requirement), alongside the
// `app/**` route tree (ADR-0001 §3.1 Variant A) — thin, deferring to the FSD config.
// next-intl handles locale detection (cookie → Accept-Language → default) and
// rewrites/redirects to the locale-prefixed routes under `app/[locale]/**`.
export default createMiddleware(routing);

export const config = {
  // Run on everything except API routes, Next internals, the bare-JSON route
  // handlers `/health` (readiness probe, app/health/route.ts) and `/config`
  // (runtime config, app/config/route.ts) — both must return their body, never a
  // locale redirect — and files with an extension (static assets). The web app
  // has no `/api` routes (the API is a separate Nest app), so this stays close to
  // the recommended next-intl matcher.
  matcher: ['/((?!api|_next|_vercel|health|config|.*\\..*).*)'],
};
