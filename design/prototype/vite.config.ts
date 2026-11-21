import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Relative base so the static build can be opened from any path (CI artifact, file server).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
