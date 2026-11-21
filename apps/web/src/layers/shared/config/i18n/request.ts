import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing';

// next-intl request-scoped config: resolves the active locale (validated against
// `routing.locales`, falling back to the default) and loads its message catalog.
// Wired into the framework by the `createNextIntlPlugin(...)` path in
// `next.config.mjs` — it is loaded by next-intl, not imported by app code, so it
// stays out of the segment's Public API.
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
