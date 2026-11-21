import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { Providers } from '@/layers/app/providers';
import { routing } from '@/layers/shared/config';
import '../globals.css';

export const metadata: Metadata = {
  title: 'ex-mio-games',
  description: 'Engagement platform for online casinos',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// Pre-render the known locales (ADR-0001 §6). Requests for any other first segment
// are rejected by `notFound()` below.
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// Locale-aware root layout (ADR-0001 §3.1 Variant A: `app/**` stays Next-routes-only
// and thin — it wires the FSD `app`-layer `Providers`, ADR-0001 §7). With the
// `[locale]` segment this is the topmost layout, so it owns `<html>`/`<body>`;
// `global-error.tsx` stays at `app/` to catch errors thrown here.
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  const { locale } = params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Opt into static rendering for next-intl; must run before any translation
  // lookup. The request locale then propagates to child Server Components.
  setRequestLocale(locale);

  // Hand the messages to the client providers — `NextIntlClientProvider` lives
  // inside the `'use client'` app-layer `Providers` and can't read the request
  // config itself.
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-bg text-fg antialiased">
        {/* FSD `app` layer providers (i18n + TanStack Query + Devtools). */}
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
