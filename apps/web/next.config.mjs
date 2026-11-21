import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point the next-intl plugin at the request config living in the FSD
// `shared/config` segment (ADR-0005 §6, §7) instead of its default `./i18n/request`.
const withNextIntl = createNextIntlPlugin('./src/layers/shared/config/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    outputFileTracingRoot: join(__dirname, '../../'),
  },
  transpilePackages: ['@ex-mio/shared-types'],
};

export default withNextIntl(nextConfig);
