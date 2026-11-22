import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PriceField, StoreItemForm } from './StoreItemForm';

const meta = {
  title: 'Composites/StoreItemForm',
  component: StoreItemForm,
  args: { onSubmit: fn() },
} satisfies Meta<typeof StoreItemForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An empty name or a price <= 0 shows errors and does not submit; valid values submit once. */
export const Validation: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Add item' }));
    await expect(c.getByText('Enter a name.')).toBeVisible();
    await expect(c.getByText('Enter a whole number of coins above 0.')).toBeVisible();
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await userEvent.type(c.getByLabelText('Name'), 'Free spins');
    await userEvent.type(c.getByLabelText('Price (coins)'), '0');
    await userEvent.click(c.getByRole('button', { name: 'Add item' }));
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(c.getByLabelText('Price (coins)'));
    await userEvent.type(c.getByLabelText('Price (coins)'), '500');
    await userEvent.type(c.getByLabelText('Bonus value (EUR)'), '5');
    await userEvent.click(c.getByRole('button', { name: 'Add item' }));
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(args.onSubmit).toHaveBeenCalledWith({
      name: 'Free spins',
      priceCoins: 500,
      bonusEur: 5,
    });
  },
};

export const Price: StoryObj<typeof PriceField> = {
  name: 'PriceField',
  render: () => {
    const [v, setV] = useState(500);
    return <PriceField label="Price (coins)" value={v} onChange={setV} />;
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = c.getByLabelText('Price (coins)');
    await expect(c.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, '-3');
    await expect(c.getByRole('alert')).toHaveTextContent('whole number of coins above 0');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
  },
};
