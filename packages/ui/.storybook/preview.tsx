import type { Preview } from '@storybook/react';
import { MIO_DEFAULT, THEMES, themeStyle } from '../src/theme/theme';
// Tailwind layers + the token variables, so stories render exactly as the apps do.
import './storybook.css';

// Theme toolbar: every story can be reviewed under each tenant theme. The decorator applies the
// theme the same way the widget does in production (inline CSS variables on a root element).
const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    a11y: { test: 'error' },
  },
  globalTypes: {
    theme: {
      description: 'Tenant theme',
      defaultValue: 'mio',
      toolbar: {
        title: 'Tenant theme',
        icon: 'paintbrush',
        items: THEMES.map((t) => ({ value: t.id, title: t.name })),
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = THEMES.find((t) => t.id === context.globals.theme) ?? MIO_DEFAULT;
      return (
        <div style={themeStyle(theme)} className="min-h-[100px] bg-bg p-6 text-fg">
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
