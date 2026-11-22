/** Tailwind config for Storybook; apps build their own with the same preset. */
module.exports = {
  presets: [require('./tailwind-preset')],
  content: ['./src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx}'],
};
