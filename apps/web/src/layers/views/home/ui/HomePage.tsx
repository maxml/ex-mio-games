import { getLocale, getTranslations } from 'next-intl/server';
import { ApiHealthStatus } from '@/layers/widgets/api-health';
import { resolveApiBaseUrl, joinApiUrl } from '@/layers/shared/config';
import { HealthCheck } from '@/layers/shared/types';
import { Card, Heading, Link, Text } from '@/layers/shared/ui';

type HealthState = { reachable: false } | { reachable: true; status: string };

async function fetchHealth(): Promise<HealthState> {
  // SSR runs on the web server, so it needs an ABSOLUTE base — a relative path
  // has no origin to anchor a server-side fetch. Runtime resolution: `API_URL`
  // (internal, runtime) with a build-time `NEXT_PUBLIC_API_URL` fallback for dev.
  // Unset -> treat the API as unreachable rather than crash.
  const base = resolveApiBaseUrl();
  if (!base) return { reachable: false };

  // Liveness probe stays 200 even during incidents, so a failure here means the
  // API process itself is unreachable.
  try {
    const live = await fetch(joinApiUrl(base, '/healthz/live'), { cache: 'no-store' });
    if (!live.ok) return { reachable: false };
  } catch {
    return { reachable: false };
  }

  // /healthz returns 503 (with a `degraded` body) when a dependency is down, so
  // read the body regardless of status to surface "degraded" instead of
  // collapsing it into "unreachable". Validate it with the shared Zod schema.
  try {
    const res = await fetch(joinApiUrl(base, '/healthz/ready'), { cache: 'no-store' });
    const body = HealthCheck.parse(await res.json());
    return { reachable: true, status: body.status };
  } catch {
    return { reachable: true, status: 'degraded' };
  }
}

export async function HomePage() {
  // Server-side i18n (ADR-0001 §6): Server Components read translations directly via
  // `getTranslations` (no client provider needed); the active locale comes from
  // the parent `[locale]` layout.
  const t = await getTranslations('home');
  const locale = await getLocale();
  const health = await fetchHealth();

  return (
    <div className="mx-auto flex max-w-screen-md flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <Heading level={1}>{t('title')}</Heading>
        <Text tone="muted">{t('subtitle')}</Text>
      </header>

      <Card title={t('apiHealthTitle')}>
        <Text tone="muted">
          {health.reachable ? t('apiReachable', { status: health.status }) : t('apiUnreachable')}
        </Text>
      </Card>

      {/* Client island (ADR-0001 §4.1): this Server Component renders the first
          paint above, then delegates live polling to a `'use client'` widget. */}
      <ApiHealthStatus />

      <Card
        title="Screens"
        description="Built only from the design system; data is mocked unless NEXT_PUBLIC_MIO_API=http."
      >
        <ul className="grid gap-2 text-sm">
          <li>
            <Link href={`/${locale}/embed/widget`}>Player widget (embeddable)</Link>
          </li>
          <li>
            <Link href={`/${locale}/operator`}>Operator console</Link>
          </li>
          <li>
            <Link href={`/${locale}/admin`}>Platform admin</Link>
          </li>
        </ul>
      </Card>
    </div>
  );
}
