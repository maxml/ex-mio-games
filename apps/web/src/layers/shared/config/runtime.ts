// Runtime configuration resolver: the single source of truth for the API base
// URL, resolved at REQUEST time rather than baked into the image at build.
//
// Why this exists: `NEXT_PUBLIC_*` vars are statically inlined into BOTH the
// server and client bundles at `next build`, so baking `NEXT_PUBLIC_API_URL`
// freezes a domain into the image and forces a rebuild to promote dev -> prod.
// Instead:
//   - The web SERVER (SSR / route handlers) reads a non-public, runtime env
//     (`API_URL`) — read fresh on every call in the standalone `node server.js`,
//     so the SAME image serves any domain.
//   - The BROWSER defaults to the SAME ORIGIN (relative `/api`, `/healthz`,
//     `…`): under single-host path routing the edge proxy sends those paths to
//     the API, so no absolute URL — and therefore no domain — is baked. The
//     production image is domain-agnostic by construction.
//
// See `apps/web/app/config/route.ts` for the runtime introspection/override
// surface and the README "Runtime web configuration" section.

/** Shape of the public runtime config surfaced to the browser (via `/config`). */
export interface PublicRuntimeConfig {
  /**
   * Browser-facing API base URL. An empty string means "same origin": the
   * browser uses relative paths (`/api/...`, `/healthz`) which the single-host
   * edge proxy routes to the API. A non-empty absolute URL is used verbatim —
   * for the `next dev` cross-origin case (web :3000 -> api :4000) or a
   * `single_host: false` deployment with per-service subdomains.
   */
  apiUrl: string;
}

/** True when running on the server (no DOM). Kept tiny so it inlines/tree-shakes. */
const isServer = (): boolean => typeof window === 'undefined';

/** Optional runtime override injected into the page (`window.__APP_CONFIG__`). */
function injectedConfig(): Partial<PublicRuntimeConfig> | undefined {
  return (globalThis as { __APP_CONFIG__?: Partial<PublicRuntimeConfig> }).__APP_CONFIG__;
}

/**
 * Resolve the API base URL for the current runtime context.
 *
 * Precedence:
 *   1. `explicit` — an injected override (tests, `HttpClientConfig.baseUrl`).
 *   2. Server: `process.env.API_URL` (runtime, non-public) then build-time
 *      `NEXT_PUBLIC_API_URL` (dev / back-compat). A server fetch needs an
 *      absolute origin, so an empty result is a misconfiguration the caller
 *      surfaces (see the HTTP client's `config_error`).
 *   3. Client: a runtime-injected `window.__APP_CONFIG__.apiUrl`, then build-time
 *      `NEXT_PUBLIC_API_URL` (dev cross-origin), else `''` (same origin) — the
 *      domain-agnostic default the production image ships with.
 */
export function resolveApiBaseUrl(explicit?: string): string {
  if (explicit) return explicit;

  if (isServer()) {
    return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '';
  }

  const injected = injectedConfig();
  if (injected?.apiUrl != null) return injected.apiUrl;
  return process.env.NEXT_PUBLIC_API_URL ?? '';
}

/** Swap an `http(s)://` origin to its `ws(s)://` equivalent; leaves other
 * schemes (an already-`ws(s)://` override, a relative value) untouched. */
function httpToWs(url: string): string {
  return url.replace(/^http(s?):\/\//i, 'ws$1://');
}

/**
 * Same-origin WebSocket base derived from the live document location — `wss://`
 * on an https page, `ws://` on http, keeping the page's host. Nothing is baked,
 * so the domain-agnostic image speaks realtime on whatever host serves it.
 * Browser-only: callers guard with {@link isServer} before reaching here.
 */
function sameOriginWsBase(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}`;
}

/**
 * Resolve the realtime WebSocket base ORIGIN (scheme + host, no namespace/path)
 * for the current runtime context — the WS analogue of {@link resolveApiBaseUrl},
 * driven by the SAME runtime override surface so one config controls both.
 *
 * Precedence:
 *   1. `explicit` — an injected override (tests, `WsClientOptions.url`), scheme
 *      normalized to `ws(s)`.
 *   2. A configured API base — a runtime `window.__APP_CONFIG__.apiUrl`, then the
 *      build-time `NEXT_PUBLIC_API_URL` (both via `resolveApiBaseUrl`): an
 *      absolute origin is reused with its scheme swapped to `ws`/`wss`. This is
 *      the cross-origin path (dev web :3000 -> api :4000, or a `single_host:false`
 *      deployment): the WS gateway shares the API origin.
 *   3. Browser default: SAME ORIGIN, derived from `window.location` — nothing
 *      baked, so realtime is ON (not off) when `NEXT_PUBLIC_API_URL` is unset.
 *   4. Server / no window with no configured base: `''`. The socket is only ever
 *      created in the browser (newing it during SSR throws), so this is a
 *      defensive fallback the caller treats as "no origin".
 */
export function resolveWsBaseUrl(explicit?: string): string {
  if (explicit) return httpToWs(explicit);

  const apiBase = resolveApiBaseUrl();
  if (apiBase) return httpToWs(apiBase);

  if (!isServer()) return sameOriginWsBase();
  return '';
}

/**
 * The public config the server exposes to the browser via the `/config` route.
 * Computed at request time from the PUBLIC-facing runtime env (`PUBLIC_API_URL`),
 * defaulting to same origin (`''`).
 *
 * NB: this is deliberately the *browser* base, sourced from `PUBLIC_API_URL` —
 * never the internal `API_URL` the server uses for SSR, so an internal hostname
 * is never leaked to the client.
 */
export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  return { apiUrl: process.env.PUBLIC_API_URL ?? '' };
}

/** Join a base (possibly `''` for same-origin) and a path into a request URL. */
export function joinApiUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
