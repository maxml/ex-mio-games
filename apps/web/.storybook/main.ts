import type { StorybookConfig } from '@storybook/react-vite';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vite';

// Storybook for the web app's `shared/ui` design system (ADR-0005 §8 / docs/tasks/
// future/add-storybook.md). React + Vite builder — the repo already ships
// Vite 8, and the seed components are framework-agnostic Tailwind components.
const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  // Stories are colocated next to their components in src/layers/shared/ui.
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  // The repo's Vite 8 (rolldown) doesn't enable the JSX transform on its own, so
  // wire @vitejs/plugin-react explicitly to compile the .tsx components/stories.
  viteFinal: (cfg) => mergeConfig(cfg, { plugins: [react()] }),
};

export default config;
