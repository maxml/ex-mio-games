import type { StorybookConfig } from '@storybook/react-vite';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vite';

// Storybook for the design system. React + Vite builder; the repo's Vite 8 does
// not enable the JSX transform on its own, so @vitejs/plugin-react is wired
// explicitly. Stories sit next to their components in src/.
const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  viteFinal: (cfg) => mergeConfig(cfg, { plugins: [react()] }),
};

export default config;
