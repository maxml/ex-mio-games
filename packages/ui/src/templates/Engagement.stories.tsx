import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { RuleValues } from '../RuleEditor';
import {
  RulesTemplate,
  StoreTemplate,
  WheelTemplate,
  type RulesTemplateProps,
  type StoreAdminItem,
  type StoreTemplateProps,
  type WheelTemplateProps,
} from './Engagement';
import { ADMIN_STORE_ITEMS, WHEEL_ROWS, WHEEL_VERSIONS, shellFor } from './fixtures';

// One file, a story per page: Rules, Wheel, Store. Each page has Admin, Staff, Support, Empty,
// Loading and Error variants. A read role gets `readOnly`.
const meta = {
  title: 'Templates/Operator/Engagement',
  component: RulesTemplate,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RulesTemplate>;

export default meta;
type Story = StoryObj;

const onSave = fn();
const onPublish = fn();
const onAddItem = fn();

function RulesDemo(p: Partial<RulesTemplateProps>) {
  const [value, setValue] = useState<RuleValues>({ min: 20, spins: 1, per: true, cap: 10 });
  return (
    <RulesTemplate
      shell={shellFor('admin')}
      value={value}
      onChange={setValue}
      preview={`Preview: a 40 EUR deposit earns ${Math.min(Math.floor(40 / (value.min || 1)) * value.spins, value.cap)} spin(s).`}
      onSave={onSave}
      {...p}
    />
  );
}

function WheelDemo(p: Partial<WheelTemplateProps>) {
  const [weights, setWeights] = useState([30, 24, 18, 12]);
  return (
    <WheelTemplate
      shell={shellFor('admin')}
      rows={WHEEL_ROWS}
      weights={weights}
      onChangeWeight={(i, v) => setWeights((cur) => cur.map((x, j) => (j === i ? v : x)))}
      onPublish={onPublish}
      versions={WHEEL_VERSIONS}
      {...p}
    />
  );
}

function StoreDemo(p: Partial<StoreTemplateProps> & { items?: StoreAdminItem[] }) {
  const [items, setItems] = useState(p.items ?? ADMIN_STORE_ITEMS);
  return (
    <StoreTemplate
      shell={shellFor('admin')}
      items={items}
      onAddItem={(v) => {
        onAddItem(v);
        setItems((cur) => [...cur, { id: `n${cur.length}`, visible: true, ...v }]);
      }}
      onPrice={(id, price) =>
        setItems((cur) => cur.map((i) => (i.id === id ? { ...i, priceCoins: price } : i)))
      }
      onVisibility={(id, visible) =>
        setItems((cur) => cur.map((i) => (i.id === id ? { ...i, visible } : i)))
      }
      {...p}
    />
  );
}

const err = 'Could not load this page. Try again.';

// Rules
export const RulesAdmin: Story = { render: () => <RulesDemo /> };
export const RulesStaff: Story = {
  render: () => <RulesDemo readOnly shell={shellFor('staff')} />,
};
export const RulesSupport: Story = {
  render: () => <RulesDemo readOnly shell={shellFor('support')} />,
};
export const RulesEmpty: Story = { render: () => <RulesDemo state="empty" /> };
export const RulesLoading: Story = { render: () => <RulesDemo state="loading" /> };
export const RulesError: Story = { render: () => <RulesDemo state="error" errorText={err} /> };

/** Save is enabled only when the values are valid, and a click calls `onSave` with them. */
export const RulesSave: Story = {
  render: () => <RulesDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const save = c.getByRole('button', { name: 'Save rule' });
    await expect(save).toBeEnabled();
    const min = c.getByLabelText('Minimum deposit (EUR)');
    await userEvent.clear(min);
    await userEvent.type(min, '0');
    await expect(save).toBeDisabled();
    await userEvent.clear(min);
    await userEvent.type(min, '25');
    await expect(save).toBeEnabled();
    await userEvent.click(save);
    await expect(onSave).toHaveBeenCalledTimes(1);
    await expect(onSave).toHaveBeenCalledWith({ min: 25, spins: 1, per: true, cap: 10 });
  },
};

// Wheel
export const WheelAdmin: Story = { render: () => <WheelDemo /> };
export const WheelStaff: Story = {
  render: () => <WheelDemo readOnly shell={shellFor('staff')} />,
};
export const WheelSupport: Story = {
  render: () => <WheelDemo readOnly shell={shellFor('support')} />,
};
export const WheelEmpty: Story = { render: () => <WheelDemo state="empty" /> };
export const WheelLoading: Story = { render: () => <WheelDemo state="loading" /> };
export const WheelError: Story = { render: () => <WheelDemo state="error" errorText={err} /> };

/** A valid draft publishes its weights; an invalid one disables Publish. */
export const WheelPublish: Story = {
  render: () => <WheelDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const publish = c.getByRole('button', { name: 'Publish' });
    await expect(publish).toBeEnabled();
    const w = c.getByLabelText('Weight for 25 coins');
    await userEvent.clear(w);
    await userEvent.type(w, '0');
    await expect(w).toHaveAttribute('aria-invalid', 'true');
    await expect(publish).toBeDisabled();
    await userEvent.clear(w);
    await userEvent.type(w, '20');
    await expect(publish).toBeEnabled();
    await userEvent.click(publish);
    await expect(onPublish).toHaveBeenCalledTimes(1);
    await expect(onPublish).toHaveBeenCalledWith([30, 20, 18, 12]);
  },
};

// Store
export const StoreAdmin: Story = {
  render: () => <StoreDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByLabelText('Name'), 'Cashback week');
    await userEvent.type(c.getByLabelText('Price (coins)'), '900');
    await userEvent.click(c.getByRole('button', { name: 'Add item' }));
    await expect(onAddItem).toHaveBeenCalledWith({
      name: 'Cashback week',
      priceCoins: 900,
      bonusEur: 0,
    });
    await expect(c.getByText('Cashback week')).toBeVisible();
  },
};

/** Staff and Support: the list only. No add form, no price input, no visibility checkbox. */
export const StoreStaff: Story = {
  render: () => <StoreDemo readOnly shell={shellFor('staff')} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('20 free spins')).toBeVisible();
    await expect(c.queryByRole('button', { name: /Add/ })).not.toBeInTheDocument();
    await expect(c.queryByRole('spinbutton')).not.toBeInTheDocument();
    await expect(c.queryByRole('checkbox')).not.toBeInTheDocument();
  },
};
export const StoreSupport: Story = {
  render: () => <StoreDemo readOnly shell={shellFor('support')} />,
};
export const StoreEmpty: Story = {
  render: () => <StoreDemo items={[]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('No items yet.')).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'Add your first item' }));
    await expect(c.getByLabelText('Name')).toBeVisible();
  },
};
export const StoreLoading: Story = { render: () => <StoreDemo state="loading" /> };
export const StoreError: Story = { render: () => <StoreDemo state="error" errorText={err} /> };
