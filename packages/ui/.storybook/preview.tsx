import type { Preview } from '@storybook/react';
// Tailwind layers + the token variables, so stories render exactly as the apps do.
import './storybook.css';

// Theme toggle: flips the `.dark` class the tokens key off, so both themes are
// reviewable from the toolbar.
const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
  globalTypes: {
    theme: {
      description: 'Design-token theme',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div className={context.globals.theme === 'dark' ? 'dark' : ''}>
        <div className="bg-background text-foreground p-6">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default preview;
