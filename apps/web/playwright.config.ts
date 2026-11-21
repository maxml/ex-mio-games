import { defineConfig, devices } from '@playwright/test';

// Playwright e2e for the web app (ADR-0005 §8). One smoke spec asserts the home page
// renders and next-intl locale routing works (`/en` vs `/uk`). The webServer
// builds and serves the production app on a dedicated test port with no baked
// NEXT_PUBLIC_API_URL — exactly the domain-agnostic production image. The smoke
// test needs no backend: the SSR/API widgets degrade gracefully, and the
// realtime WS now resolves to the SAME ORIGIN (no baked domain) and simply
// backs off harmlessly when no gateway is reachable — it no longer disables
// itself, and never throws at mount.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

// Exercise the SAME runtime Docker ships: `output: 'standalone'` + `node
// server.js` (apps/web/Dockerfile), not `next start`. After `next build`, Next
// emits a self-contained server under `.next/standalone` but does NOT copy the
// static assets or `public/` into it (a documented standalone caveat), so we
// copy them in — to the paths the monorepo tracing root produces
// (`outputFileTracingRoot` = repo root → `.next/standalone/apps/web/...`),
// exactly mirroring the Dockerfile's COPY steps — then boot `server.js`. The
// copy uses Node's `fs.cpSync` so it stays portable across dev OSes.
const standaloneRoot = '.next/standalone/apps/web';
const copyStandaloneAssets =
  `node -e "const{cpSync}=require('node:fs');` +
  `cpSync('.next/static','${standaloneRoot}/.next/static',{recursive:true});` +
  `cpSync('public','${standaloneRoot}/public',{recursive:true})"`;
const webServerCommand = `pnpm exec next build && ${copyStandaloneAssets} && node ${standaloneRoot}/server.js`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: webServerCommand,
    // The standalone server reads PORT/HOSTNAME from the env (there is no `-p`
    // flag), so pass them through; bind loopback to match `baseURL`.
    env: { PORT: String(PORT), HOSTNAME: '127.0.0.1' },
    url: `${baseURL}/en`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
