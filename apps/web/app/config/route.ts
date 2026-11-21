import { getPublicRuntimeConfig } from '@/layers/shared/config/runtime';

// Runtime web configuration endpoint. Returns the PUBLIC config the browser
// needs — resolved at REQUEST time, not baked at build — so the same image
// serves any environment without a rebuild.
//
// `force-dynamic`: read `PUBLIC_API_URL` from the live env on every request. A
// static route would freeze the build-time value into the image, defeating the
// whole point.
//
// Path safety: like `/health`, this lives on a path the API does not claim
// (the single-host proxy routes `/api/*`, `/socket.io/*`, `/healthz*`, `/docs*`
// to the API; everything else -> web) and is excluded from the next-intl
// middleware matcher, so it returns bare JSON and never locale-redirects.
//
// Consumers: operational verification (`curl …/config` in each env proves the
// runtime resolution), and a `single_host: false` deployment can bootstrap
// `window.__APP_CONFIG__` from this before making cross-origin API calls. The
// single-host default (`apiUrl: ''`) means "same origin", so the browser needs
// no override there.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(JSON.stringify(getPublicRuntimeConfig()), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
