'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { NextIntlClientProvider, type Messages } from 'next-intl';
import { useState, type ReactNode } from 'react';
import type { Locale } from '@/layers/shared/config';
import { WSProvider } from './WSProvider';

// FSD `app` layer (ADR-0005 §3.1, §7): cross-cutting providers / initialization that
// the Next route shell (`apps/web/app/[locale]/layout.tsx`) composes around the
// tree. This is the single composition point for client-side providers.
//
// Client island: the QueryClient must live in a `'use client'` boundary so its
// cache is created once on the client. `useState` with a lazy initializer keeps
// the instance stable across re-renders (a `new QueryClient()` in the render
// body would discard the cache on every render). This is the documented App
// Router pattern; the streaming-SSR singleton variant is intentionally deferred.
//
// i18n (ADR-0005 §6): `NextIntlClientProvider` makes `useTranslations` available to
// client components. As a client boundary it can't read the request config
// itself, so the server layout passes `locale` + `messages` down as props (the
// standard next-intl App Router handoff). Server Components use `getTranslations`
// directly and don't need this provider.
export function Providers({
  children,
  locale,
  messages,
}: {
  children: ReactNode;
  locale: Locale;
  messages: Messages;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // ADR-0003 §5.2: WS-driven data favors a high staleTime; pick a sane
          // default here so query islands don't refetch on every mount.
          queries: { staleTime: 60_000 },
        },
      }),
  );

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <QueryClientProvider client={queryClient}>
        {/* Realtime singleton socket (ADR-0003 §5.2); shares this QueryClient. */}
        <WSProvider>{children}</WSProvider>
        {process.env.NODE_ENV === 'development' ? (
          <ReactQueryDevtools initialIsOpen={false} />
        ) : null}
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}
