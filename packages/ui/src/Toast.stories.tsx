import type { Meta, StoryObj } from '@storybook/react';
import { Alert, Toast } from './Toast';

const meta = { title: 'Primitives/Alert and Toast', component: Alert } satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj;

export const Info: Story = { args: { tone: 'info', children: 'A sandbox is ready for you.' } };
export const Success: Story = { args: { tone: 'success', children: 'Account created.' } };
export const Warning: Story = {
  args: { tone: 'warning', children: 'Live keys stay locked until the sandbox test passes.' },
};
export const Danger: Story = { args: { tone: 'danger', children: 'The card was declined.' } };

export const ToastMessage: Story = {
  render: () => (
    <Toast tone="success" message="Webhook secret rotated." onDismiss={() => undefined} />
  ),
};
/** The live region stays in the DOM when empty so the next message is announced. */
export const ToastEmpty: Story = {
  render: () => <Toast message="" onDismiss={() => undefined} />,
};
