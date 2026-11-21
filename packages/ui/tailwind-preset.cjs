// Tailwind preset that maps the CSS-variable tokens (src/tokens.css) to utilities.
// An app adds it with `presets: [require('@ex-mio/ui/tailwind-preset')]` and
// includes this package's sources in `content`.
const defaultTheme = require('tailwindcss/defaultTheme');

const color = (name) => `hsl(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        border: color('border'),
        input: color('input'),
        ring: color('ring'),
        background: color('background'),
        foreground: color('foreground'),
        primary: { DEFAULT: color('primary'), foreground: color('primary-foreground') },
        secondary: { DEFAULT: color('secondary'), foreground: color('secondary-foreground') },
        muted: { DEFAULT: color('muted'), foreground: color('muted-foreground') },
        destructive: { DEFAULT: color('destructive'), foreground: color('destructive-foreground') },
        card: { DEFAULT: color('card'), foreground: color('card-foreground') },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: { sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans] },
    },
  },
};
