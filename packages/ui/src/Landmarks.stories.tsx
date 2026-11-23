import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { Heading } from './Typography';
import { LiveRegion, Main, SignedAmount, ThemeScope } from './Landmarks';
import { Stack } from './Layout';
import { THEMES, ThemeProvider } from './theme/theme';

const meta = { title: 'Primitives/Landmarks', component: Main } satisfies Meta<typeof Main>;

export default meta;
type Story = StoryObj;

export const MainLandmark: Story = {
  render: () => (
    <Main narrow>
      <Heading>Page body</Heading>
    </Main>
  ),
  play: async ({ canvasElement }) => {
    const main = within(canvasElement).getByRole('main');
    await expect(main).toHaveAttribute('id', 'main');
    await expect(main).toHaveAttribute('tabindex', '-1');
  },
};

export const ThemedMain: Story = {
  render: () => (
    <Main theme={THEMES[THEMES.length - 1]}>
      <Heading>Tenant look</Heading>
    </Main>
  ),
};

export const Scope: Story = {
  render: () => (
    <ThemeProvider initialId="mio">
      <ThemeScope>
        <Heading level={3}>Inside the theme scope</Heading>
      </ThemeScope>
    </ThemeProvider>
  ),
};

export const Live: Story = {
  render: () => (
    <Stack gap={2}>
      <LiveRegion data-testid="hidden-live">You won 100 coins</LiveRegion>
      <LiveRegion visible>Shown live region</LiveRegion>
    </Stack>
  ),
  play: async ({ canvasElement }) => {
    const live = within(canvasElement).getByTestId('hidden-live');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveTextContent('You won 100 coins');
  },
};

export const Amounts: Story = {
  render: () => (
    <Stack row gap={4}>
      <SignedAmount value={100} />
      <SignedAmount value={-40} />
      <SignedAmount value={0} />
    </Stack>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('+100')).toBeInTheDocument();
    await expect(c.getByText('-40')).toBeInTheDocument();
    await expect(c.getByText('spins')).toBeInTheDocument();
  },
};
