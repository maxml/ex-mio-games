/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vitest config for the web app's unit/component suite (ADR-0013 §8). The repo
// already ships Vite 8 + Vitest 4 (Storybook builds on the same toolchain), so
// web tests run on Vitest while the other projects (api, generators, auth) keep
// Jest. jsdom gives Testing Library a DOM; MSW (wired in ./src/test/setup.ts)
// intercepts the typed `http` client's fetch calls.
const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Mirror the jest `moduleNameMapper`: resolve the shared schemas from
      // source (not the built `dist`) so tests don't depend on a prior build.
      {
        find: '@ex-mio/contracts',
        replacement: resolvePath('../../packages/contracts/src/index.ts'),
      },
      // App alias (`@/*` -> `src/*`), matching apps/web/tsconfig.json.
      { find: /^@\//, replacement: `${resolvePath('./src')}/` },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Playwright specs live in ./e2e and run under @playwright/test, not Vitest.
    exclude: ['node_modules', 'dist', '.next', 'e2e/**'],
    clearMocks: true,
    // A stable base URL for the typed `http` client; MSW handlers match any host
    // via `*/...`, so the exact value only needs to be a valid absolute URL.
    env: {
      NEXT_PUBLIC_API_URL: 'http://localhost:4000',
    },
  },
});
