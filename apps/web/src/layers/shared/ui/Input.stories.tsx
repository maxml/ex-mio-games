import type { Meta, StoryObj } from '@storybook/react';
import { Input } from './Input';

const meta = {
  title: 'shared/ui/Input',
  component: Input,
  args: { placeholder: 'Email address' },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithValue: Story = { args: { defaultValue: 'hello@example.com' } };
export const Disabled: Story = { args: { disabled: true, value: 'Disabled' } };
export const Password: Story = { args: { type: 'password', placeholder: 'Password' } };
