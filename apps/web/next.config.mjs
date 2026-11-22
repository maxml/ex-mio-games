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
  // The realtime gateway lives in engagement (Socket.IO, namespace /rt). The browser opens the socket on
  // the web origin and Next proxies it (HTTP and the websocket upgrade) to engagement, so there is no
  // second public origin, no CORS and no runtime URL for the client. Read at build time: the default is
  // the compose service name; for `next dev` set REALTIME_UPSTREAM=http://localhost:4002.
  async rewrites() {
    const upstream = process.env.REALTIME_UPSTREAM ?? 'http://engagement:4002';
    return [{ source: '/socket.io/:path*', destination: `${upstream}/socket.io/:path*` }];
  },
};

export default withNextIntl(nextConfig);
