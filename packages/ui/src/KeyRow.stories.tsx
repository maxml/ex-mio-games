import type { Meta, StoryObj } from '@storybook/react';
import { KeyList, KeyRow } from './KeyRow';

const meta = { title: 'Composites/KeyRow', component: KeyRow } satisfies Meta<typeof KeyRow>;

export default meta;
type Story = StoryObj;

export const List: Story = {
  render: () => (
    <KeyList>
      <KeyRow
        label="Publishable key (widget)"
        value="pk_test_9d41c0a7e2b84f10"
        onCopy={() => undefined}
      />
      <KeyRow
        label="Secret key (server to server)"
        value={'sk_test_' + '•'.repeat(20)}
        onCopy={() => undefined}
      />
    </KeyList>
  ),
};
