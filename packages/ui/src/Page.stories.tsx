import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card';
import { Page, SiteHeader, SkipLink, ThemeSwitcher } from './Page';
import { ThemeProvider } from './theme/theme';

const meta = { title: 'Templates/Page', component: Page } satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj;

export const Default: Story = {
  args: {
    title: 'Platform admin',
    intro: 'Our own view across all operators.',
    children: <Card title="Operators">Table goes here</Card>,
  },
};

export const HeaderWithThemeSwitcher: Story = {
  render: () => (
    <ThemeProvider>
      <SkipLink />
      <SiteHeader
        current="operator"
        items={[
          { id: 'player', label: 'Player widget', href: '#player' },
          { id: 'operator', label: 'Operator console', href: '#operator' },
          { id: 'admin', label: 'Platform admin', href: '#admin' },
        ]}
      >
        <ThemeSwitcher />
      </SiteHeader>
    </ThemeProvider>
  ),
};
