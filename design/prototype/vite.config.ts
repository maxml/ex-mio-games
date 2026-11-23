import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '../../packages/ui');

// Relative base so the static build can be opened from any path (CI artifact, file server).
// `@ex-mio/ui` is the repo's design system (packages/ui). The prototype is outside the pnpm workspace,
// so it reads the sources through an alias, and keeps one copy of React so hooks work across both trees.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@ex-mio\/ui$/, replacement: path.join(ui, 'src/index.ts') },
      { find: /^@ex-mio\/ui\/(.*)$/, replacement: path.join(ui, 'src/$1') },
      { find: /^react$/, replacement: path.resolve(here, 'node_modules/react') },
      { find: /^react\/(.*)$/, replacement: path.resolve(here, 'node_modules/react/$1') },
      { find: /^react-dom$/, replacement: path.resolve(here, 'node_modules/react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: path.resolve(here, 'node_modules/react-dom/$1') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { fs: { allow: [path.resolve(here, '../..')] } },
});
