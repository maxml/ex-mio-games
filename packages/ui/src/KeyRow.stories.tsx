import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { KeyList, KeyRow } from './KeyRow';

const meta = { title: 'Composites/KeyRow', component: KeyRow } satisfies Meta<typeof KeyRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  args: { label: 'Publishable key (widget)', value: 'pk_test_EXAMPLE' },
  render: () => (
    <KeyList>
      <KeyRow label="Publishable key (widget)" value="pk_test_EXAMPLE" onCopy={() => undefined} />
      <KeyRow label="Secret key (server to server)" value="sk_test_EXAMPLE" secret />
    </KeyList>
  ),
};

/** A secret is masked until Reveal; Hide masks it again; Copy reports once. */
export const Secret: Story = {
  args: { label: 'Secret key', value: 'sk_test_EXAMPLE', secret: true, onCopy: fn() },
  render: (args) => (
    <KeyList>
      <KeyRow {...args} />
    </KeyList>
  ),
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.queryByText('sk_test_EXAMPLE')).not.toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Reveal Secret key' }));
    await expect(c.getByText('sk_test_EXAMPLE')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'Hide Secret key' }));
    await expect(c.queryByText('sk_test_EXAMPLE')).not.toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Copy Secret key' }));
    await expect(args.onCopy).toHaveBeenCalledTimes(1);
  },
};
