import { getTranslations } from 'next-intl/server';
import { ApiHealthStatus } from '@/layers/widgets/api-health';
import { resolveApiBaseUrl, joinApiUrl } from '@/layers/shared/config';
import { HealthCheck } from '@/layers/shared/types';

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
  const health = await fetchHealth();

  return (
    <main className="mx-auto flex max-w-screen-md flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold sm:text-2xl">{t('title')}</h1>
        <p className="text-sm text-neutral-400">{t('subtitle')}</p>
      </header>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-2 text-base font-medium">{t('apiHealthTitle')}</h2>
        <p className="text-sm text-neutral-400">
          {health.reachable ? t('apiReachable', { status: health.status }) : t('apiUnreachable')}
        </p>
      </section>

      {/* Client island (ADR-0001 §4.1): this Server Component renders the first
          paint above, then delegates live polling to a `'use client'` widget. */}
      <ApiHealthStatus />
    </main>
  );
}
