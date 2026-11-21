// Lightweight web readiness probe (200) for external delivery/uptime checks.
//
// The API owns `/healthz/{live,ready}` (a separate Nest app). Under single-host
// path routing the edge proxy sends `/healthz*` to the API, so the web needs its
// OWN 200 route on a path the API does not claim — this one. Deckhand's
// blue-green cutover gates on each public service's readiness, so the web must
// answer for itself (see `.deckhand/deploy.yml` → services.web.health.ready).
//
// Dependency-free, and excluded from the next-intl middleware (see middleware.ts)
// so it returns a bare 200 and never locale-redirects.
//
// `force-dynamic` (not `force-static`): the probe reports the RUNNING build's
// version from `process.env.APP_VERSION`, which Deckhand injects at RUNTIME
// (deploy.yml → version.inject_as: APP_VERSION). A static route would freeze the
// build-time value into the image; dynamic reads the live env per request, and a
// readiness probe must reflect the live process anyway (never a cached asset).
export const dynamic = 'force-dynamic';

export function GET() {
  // `version` is `null` when APP_VERSION is unset (dev / local `next start`).
  const version = process.env.APP_VERSION ?? null;
  return new Response(JSON.stringify({ status: 'ok', version }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
