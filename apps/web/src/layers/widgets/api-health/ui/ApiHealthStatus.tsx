'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { queryKeys } from '@/layers/shared/api';
import { resolveApiBaseUrl, joinApiUrl } from '@/layers/shared/config';
import { useUiStore } from '@/layers/shared/lib';
import { HealthCheck } from '@/layers/shared/types';
import { Card, Text } from '@/layers/shared/ui';

// Client island (ADR-0001 §4.1): RSC renders the page; this `'use client'` widget is
// the interactive island that polls the API with TanStack Query. The parent
// `HomePage` stays a Server Component.
async function fetchHealth(): Promise<HealthCheck> {
  // Runtime resolution: the browser talks to the API on the SAME ORIGIN by
  // default (relative `/healthz`, routed to the API by the single-host edge
  // proxy), so no domain is baked. `NEXT_PUBLIC_API_URL` (dev) or an injected
  // runtime override can still point it cross-origin.
  const res = await fetch(joinApiUrl(resolveApiBaseUrl(), '/healthz/ready'), { cache: 'no-store' });
  // TODO(F4): use shared http client.
  // Validate the response against the shared Zod schema (validate
  // every external input against @ex-mio/contracts).
  return HealthCheck.parse(await res.json());
}

export function ApiHealthStatus() {
  // Client-side i18n (ADR-0001 §6): `useTranslations` reads from the
  // `NextIntlClientProvider` wired in the app-layer `Providers` — proving the
  // provider composition works for `'use client'` islands.
  const t = useTranslations('apiHealth');
  // Typed selector usage example (Zustand): only re-renders on `theme` changes.
  const theme = useUiStore((state) => state.theme);

  const { data, error, isPending, isFetching } = useQuery({
    queryKey: queryKeys.health.status(),
    queryFn: fetchHealth,
    // ADR-0001 §4.1: client-side server-state — poll for liveness.
    refetchInterval: 10_000,
  });

  const label = error
    ? 'unreachable'
    : isPending
      ? 'checking…'
      : `${data.status}${isFetching ? ' (refreshing…)' : ''}`;

  return (
    <Card title={t('liveTitle')}>
      <Text tone="muted">
        Status: {label}
        <span className="ml-2 text-xs">theme: {theme}</span>
      </Text>
    </Card>
  );
}
