// Tailwind preset that maps the CSS-variable tokens (src/tokens.css) to utilities.
// An app adds it with `presets: [require('@ex-mio/ui/tailwind-preset')]` and
// includes this package's sources in `content`.
//
// Utilities read the variable at runtime (`var(--primary)`), so a tenant override on any
// ancestor element re-themes everything below it without a rebuild. Because the values are
// plain variables, colour opacity modifiers (`bg-primary/50`) are not available; add a token.
const defaultTheme = require('tailwindcss/defaultTheme');

const token = (name) => `var(--${name})`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        'surface-2': token('surface-2'),
        border: token('border'),
        'input-border': token('input-border'),
        fg: token('fg'),
        'fg-muted': token('fg-muted'),
        primary: token('primary'),
        'primary-fg': token('primary-fg'),
        accent: token('accent'),
        'accent-fg': token('accent-fg'),
        ring: token('ring'),
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
        info: token('info'),
        coin: token('coin'),
      },
      borderRadius: {
        sm: token('radius-sm'),
        md: token('radius-md'),
        lg: token('radius-lg'),
      },
      fontFamily: {
        sans: [token('font-sans'), ...defaultTheme.fontFamily.sans],
        display: [token('font-display'), ...defaultTheme.fontFamily.sans],
      },
      boxShadow: { card: token('shadow-card') },
    },
  },
};
