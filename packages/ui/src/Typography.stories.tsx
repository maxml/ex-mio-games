import type { Meta, StoryObj } from '@storybook/react';
import { Heading, Link, Text } from './Typography';

const meta = { title: 'Primitives/Typography', component: Heading } satisfies Meta<typeof Heading>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Headings: Story = {
  render: () => (
    <div className="grid gap-2">
      <Heading level={1}>Level one</Heading>
      <Heading level={2}>Level two</Heading>
      <Heading level={3}>Level three</Heading>
    </div>
  ),
};

export const TextTones: Story = {
  render: () => (
    <div className="grid gap-1">
      <Text>Default text</Text>
      <Text tone="muted">Muted text</Text>
      <Text tone="success">Saved</Text>
      <Text tone="danger">Every weight must be greater than 0.</Text>
      <Text size="xs">Small</Text>
      <Text strong>Strong</Text>
    </div>
  ),
};

export const InlineLink: Story = {
  render: () => (
    <Text>
      Rules saved. <Link href="#player">Open the player widget</Link>
    </Text>
  ),
};
