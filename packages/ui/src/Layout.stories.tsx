import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card';
import { Grid, Stack } from './Layout';
import { Text } from './Typography';

const meta = { title: 'Primitives/Layout', component: Stack } satisfies Meta<typeof Stack>;

export default meta;
type Story = StoryObj;

export const Column: Story = {
  render: () => (
    <Stack gap={3}>
      <Card title="One">
        <Text>First block.</Text>
      </Card>
      <Card title="Two">
        <Text>Second block.</Text>
      </Card>
    </Stack>
  ),
};

export const Row: Story = {
  render: () => (
    <Stack row gap={2} align="center" justify="between">
      <Text strong>Title on the left</Text>
      <Text tone="muted">Detail on the right</Text>
    </Stack>
  ),
};

export const ColumnsGrid: Story = {
  render: () => (
    <Grid cols={3}>
      {['A', 'B', 'C'].map((n) => (
        <Card key={n} title={`Card ${n}`}>
          <Text>Body</Text>
        </Card>
      ))}
    </Grid>
  ),
};
