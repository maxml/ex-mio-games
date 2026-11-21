import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardForm } from './CardForm';
import { Checkbox } from './Checkbox';
import { Field, Input } from './Input';
import { PlanCard } from './PlanCard';
import { RuleEditor, type RuleValues } from './RuleEditor';
import { StatusPill, type Status } from './StatusPill';
import { StepNav } from './StepNav';
import { StoreItemCard } from './StoreItemCard';
import { TabPanel, Tabs } from './Tabs';
import { WeightTable } from './WeightTable';
import { Stepper } from './Stepper';

describe('StatusPill: status is never colour alone', () => {
  const all: Status[] = [
    'pending',
    'issuing',
    'issued',
    'failed',
    'refunded',
    'accepted',
    'duplicate',
    'rejected',
    'active',
    'trial',
    'past_due',
    'suspended',
    'draft',
    'published',
    'archived',
    'paid',
    'open',
  ];
  it.each(all)('%s shows a word and an icon', (status) => {
    const { container } = render(<StatusPill status={status} />);
    expect(container.textContent?.trim().length).toBeGreaterThan(2);
    expect(container.querySelector('[aria-hidden]')).not.toBeNull();
  });
});

describe('Field wires label, control and message together', () => {
  it('the control is labelled and described by its hint; an error is announced', () => {
    render(
      <Field label="Work email" error="Enter an email">
        {({ id, invalid, describedBy }) => (
          <Input id={id} invalid={invalid} aria-describedby={describedBy} />
        )}
      </Field>,
    );
    const input = screen.getByLabelText('Work email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter an email');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email');
  });
});

describe('Checkbox', () => {
  it('is a labelled native checkbox that toggles', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Visible" onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('keeps an accessible name when the label is hidden', () => {
    render(<Checkbox label="Visible to players: Free spins" hideLabel />);
    expect(
      screen.getByRole('checkbox', { name: 'Visible to players: Free spins' }),
    ).toBeInTheDocument();
  });
});

describe('Tabs keyboard pattern', () => {
  function Harness() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a');
    return (
      <>
        <Tabs
          tabs={[
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ]}
          value={v}
          onChange={setV}
          label="Sections"
          idPrefix="t"
        />
        <TabPanel idPrefix="t" id={v}>
          panel {v}
        </TabPanel>
      </>
    );
  }
  it('arrows, Home and End select AND focus; only the selected tab is tabbable', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'A' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus(); // wraps
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('A');
  });
});

describe('Stepper: a tick only for finished steps', () => {
  it('marks done and current by text, not position', () => {
    render(
      <Stepper
        steps={[
          { id: 'a', label: 'One', done: true },
          { id: 'b', label: 'Two' },
          { id: 'c', label: 'Three' },
        ]}
        current={1}
      />,
    );
    expect(screen.getByText('(complete)')).toBeInTheDocument();
    expect(screen.getByText('(current step)')).toBeInTheDocument();
    expect(screen.getByText('(not done)')).toBeInTheDocument();
  });
});

describe('StepNav', () => {
  it('a blocked Continue says why and cannot be pressed', async () => {
    const onNext = vi.fn();
    render(
      <StepNav
        index={3}
        nextLabel="Continue"
        canContinue={false}
        hint="Run the test first."
        onBack={() => undefined}
        onNext={onNext}
      />,
    );
    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription('Run the test first.');
    await userEvent.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });
  it('Back is disabled on the first step', () => {
    render(
      <StepNav index={0} nextLabel="Next" onBack={() => undefined} onNext={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });
});

describe('StoreItemCard', () => {
  const item = {
    id: 's1',
    name: '20 free spins',
    description: 'd',
    priceCoins: 300,
    kind: 'free_spins' as const,
  };
  it('says how many coins are missing and blocks redeem', () => {
    render(<StoreItemCard item={item} balance={120} onRedeem={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeDisabled();
    expect(screen.getByText('180 more coins needed')).toBeInTheDocument();
  });
  it('sold out blocks redeem', () => {
    render(<StoreItemCard item={{ ...item, stock: 0 }} balance={999} onRedeem={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Sold out' })).toBeDisabled();
  });
  it('redeems when affordable', async () => {
    const onRedeem = vi.fn();
    render(<StoreItemCard item={item} balance={300} onRedeem={onRedeem} />);
    await userEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    expect(onRedeem).toHaveBeenCalledWith(item);
  });
});

describe('PlanCard', () => {
  it('is a radio that reports selection', async () => {
    const onSelect = vi.fn();
    render(
      <PlanCard
        name="Growth"
        price={799}
        spins="150,000 spins"
        extra="x"
        selected={false}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /Growth/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('RuleEditor', () => {
  it('reports edits with the other fields intact and shows the preview', async () => {
    const onChange = vi.fn();
    const value: RuleValues = { min: 20, spins: 1, per: true, cap: 10 };
    render(<RuleEditor value={value} onChange={onChange} preview="Preview: 2 spins" />);
    await userEvent.type(screen.getByLabelText('Daily spin cap per player'), '5');
    expect(onChange).toHaveBeenLastCalledWith({ ...value, cap: 105 });
    expect(screen.getByRole('status')).toHaveTextContent('Preview: 2 spins');
  });
  it('an emptied field is reported as NaN so the caller can reject it', async () => {
    const onChange = vi.fn();
    render(
      <RuleEditor
        value={{ min: 20, spins: 1, per: true, cap: 10 }}
        onChange={onChange}
        preview=""
      />,
    );
    await userEvent.clear(screen.getByLabelText('Minimum deposit (EUR)'));
    expect(Number.isNaN(onChange.mock.lastCall![0].min)).toBe(true);
  });
});

describe('WeightTable', () => {
  it('shows each segment probability from the weights', () => {
    render(
      <WeightTable
        rows={[
          { id: 'a', coins: 10 },
          { id: 'b', coins: 20 },
        ]}
        weights={[30, 10]}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText('75.0%')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();
  });
  it('flags a zero weight as invalid', () => {
    render(
      <WeightTable rows={[{ id: 'a', coins: 10 }]} weights={[0]} onChange={() => undefined} />,
    );
    expect(screen.getByLabelText('Weight for 10 coins')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('CardForm', () => {
  it('submits only the last four digits', async () => {
    const onSubmit = vi.fn();
    render(<CardForm amount={799} description="Growth" onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pay 799.00 EUR' }));
    expect(onSubmit).toHaveBeenCalledWith('4242');
  });
  it('rejects a short card number with a message and does not submit', async () => {
    const onSubmit = vi.fn();
    render(<CardForm amount={799} description="Growth" onSubmit={onSubmit} />);
    const number = screen.getByLabelText('Card number');
    await userEvent.clear(number);
    await userEvent.type(number, '4242');
    await userEvent.click(screen.getByRole('button', { name: 'Pay 799.00 EUR' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(screen.getByRole('alert')).getByText(/16-digit/)).toBeInTheDocument();
  });
  it('a second submit while processing is ignored', async () => {
    const onSubmit = vi.fn();
    render(<CardForm amount={799} description="Growth" processing onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: /Processing/ }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('shows a provider failure', () => {
    render(
      <CardForm amount={799} description="Growth" failure="Declined" onSubmit={() => undefined} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Declined');
  });
});
