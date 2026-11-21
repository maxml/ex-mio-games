import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PlanCard } from './PlanCard';

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 199,
    spins: '20,000 spins / month',
    extra: '1 casino, sandbox, email support',
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 799,
    spins: '150,000 spins / month',
    extra: '3 casinos, custom theme, webhooks log',
  },
  {
    id: 'scale',
    name: 'Scale',
    price: 2499,
    spins: '1,000,000 spins / month',
    extra: 'Unlimited casinos, SLA, single sign-on',
  },
];

const meta = { title: 'Composites/PlanCard', component: PlanCard } satisfies Meta<typeof PlanCard>;

export default meta;
type Story = StoryObj;

export const Choosing: Story = {
  render: () => {
    const [plan, setPlan] = useState('growth');
    return (
      <div role="radiogroup" aria-label="Plan" className="grid gap-3 md:grid-cols-3">
        {PLANS.map((p) => (
          <PlanCard key={p.id} {...p} selected={plan === p.id} onSelect={() => setPlan(p.id)} />
        ))}
      </div>
    );
  },
};
export const Locked: Story = {
  render: () => (
    <div role="radiogroup" aria-label="Plan" className="max-w-xs">
      <PlanCard {...PLANS[1]!} selected disabled onSelect={() => undefined} />
    </div>
  ),
};
