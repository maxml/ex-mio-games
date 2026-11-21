import type { Meta, StoryObj } from '@storybook/react';
import { CardForm } from './CardForm';

const meta = {
  title: 'Composites/CardForm',
  component: CardForm,
  args: {
    amount: 799,
    description: 'Growth plan, first month',
    testMode: true,
    onSubmit: () => undefined,
    onCancel: () => undefined,
  },
} satisfies Meta<typeof CardForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Processing: Story = { args: { processing: true } };
export const Declined: Story = {
  args: { failure: 'The card was declined by the test provider. Use 4242 4242 4242 4242 instead.' },
};
