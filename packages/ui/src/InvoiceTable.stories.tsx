import type { Meta, StoryObj } from '@storybook/react';
import { InvoiceTable } from './InvoiceTable';
import { INVOICES } from './templates/fixtures';

const meta = {
  title: 'Composites/InvoiceTable',
  component: InvoiceTable,
  args: { invoices: INVOICES },
} satisfies Meta<typeof InvoiceTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {};
export const WithPay: Story = { args: { onPay: () => undefined } };
export const Empty: Story = { args: { invoices: [] } };
