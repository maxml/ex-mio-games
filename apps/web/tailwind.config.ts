import type { Config } from 'tailwindcss';
import uiPreset from '@ex-mio/ui/tailwind-preset';

// Colors, radii and fonts come from the design tokens in `@ex-mio/ui`
// (CSS variables) through its Tailwind preset. This app adds no tokens of its own.
const config: Config = {
  presets: [uiPreset],
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};

export default config;
