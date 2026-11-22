import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point the next-intl plugin at the request config living in the FSD
// `shared/config` segment (ADR-0013 §6, §7) instead of its default `./i18n/request`.
const withNextIntl = createNextIntlPlugin('./src/layers/shared/config/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    outputFileTracingRoot: join(__dirname, '../../'),
  },
  transpilePackages: ['@ex-mio/contracts', '@ex-mio/ui'],
  // D-27: the socket.io client asks for `/socket.io/` (trailing slash). Without this flag Next answers
  // that with a 308 to `/socket.io`, which engagement (engine.io path `/socket.io/`) then 404s.
  skipTrailingSlashRedirect: true,
  // The realtime gateway lives in engagement (Socket.IO, namespace /rt). The browser's primary route is
  // the gateway's own public origin (`realtimeUrl` of `/config`, allowed through
  // REALTIME_ALLOWED_ORIGINS). This same-origin proxy is the FALLBACK (HTTP and the websocket upgrade)
  // for a deployment with one public origin; it is not relied on. Read at build time: the default is
  // the compose service name; for `next dev` set REALTIME_UPSTREAM=http://localhost:4002.
  async rewrites() {
    const upstream = process.env.REALTIME_UPSTREAM ?? 'http://engagement:4002';
    return [
      // Both spellings reach engine.io's `/socket.io/` path, whatever the client sent.
      { source: '/socket.io', destination: `${upstream}/socket.io/` },
      { source: '/socket.io/:path*', destination: `${upstream}/socket.io/:path*` },
    ];
  },
};

export default withNextIntl(nextConfig);
