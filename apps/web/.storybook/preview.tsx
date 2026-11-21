import type { Preview } from '@storybook/react';
// Tailwind entry so stories render with the design tokens (app/globals.css).
import '../app/globals.css';

// A lightweight theme toggle (no extra addon): flips the `.dark` token class the
// seed tokens key off of, so both themes are previewable from the toolbar.
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
    (Story, context) => {
      const dark = context.globals.theme === 'dark';
      return (
        <div className={dark ? 'dark' : ''}>
          <div className="bg-background text-foreground p-6">
            <Story />
          </div>
        </div>
      );
    },
  ],
};

export default preview;
