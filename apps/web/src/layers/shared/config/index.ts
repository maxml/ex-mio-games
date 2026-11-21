// Public API for the `shared/config` segment — app-wide constants and runtime
// configuration shared across layers (ADR-0005 §7).
//
// i18n (ADR-0005 §6: next-intl on web). The locale set + routing strategy and the
// locale-aware navigation primitives are the consumer-facing surface; the
// next-intl request config (`./i18n/request.ts`) is loaded by the framework via
// `next.config.mjs`, not imported through here.
export { routing, locales, defaultLocale, type Locale } from './i18n/routing';
export { Link, redirect, usePathname, useRouter, getPathname } from './i18n/navigation';

// Runtime configuration: the API base URL (and the realtime WebSocket origin)
// resolved at request time so the web image is domain-agnostic (the browser
// defaults to same origin; the SSR base comes from the runtime `API_URL` env).
// Consumed by the HTTP client, the WS client, the SSR health probe, the
// `api-health` island, and the `/config` route handler.
export {
  resolveApiBaseUrl,
  resolveWsBaseUrl,
  getPublicRuntimeConfig,
  joinApiUrl,
  type PublicRuntimeConfig,
} from './runtime';
