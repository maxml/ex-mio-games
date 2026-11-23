import { InsightsTemplate, type InvoiceRow, type UsageStat } from '@ex-mio/ui';
import { FUNNEL_PLAYER_PREVIEW, PLANS, USAGE_DAYS } from '../../mock/data';
import { startPayment, useApp } from '../../state/store';
import { useOperatorShell } from './shell';

const num = (n: number) => n.toLocaleString('en-US');

/** Insights: usage, invoices and the funnel. Staff and Support read it; only an admin gets the Pay action. */
export function InsightsScreen({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const op = useApp((s) => s.operator);
  const plan = PLANS.find((p) => p.id === (op.paidPlan ?? op.plan)) ?? PLANS[0];
  const spins = USAGE_DAYS.reduce((a, b) => a + b, 0);
  const usage: UsageStat[] = [
    { label: 'Spins this month', value: num(spins * 40) },
    { label: 'Included spins', value: plan.spins.split(' ')[0] },
    { label: 'Active players', value: num(1280) },
  ];
  const invoices: InvoiceRow[] = [
    {
      id: '2026-11',
      period: '2026-11',
      amountEur: op.paidAmount ?? plan.price,
      status: op.invoicePaid ? 'paid' : 'open',
    },
  ];
  return (
    <InsightsTemplate
      shell={shell}
      readOnly={readOnly}
      usage={usage}
      daily={USAGE_DAYS}
      invoices={invoices}
      funnel={FUNNEL_PLAYER_PREVIEW}
      onPay={() => startPayment(op.plan, '4242')}
    />
  );
}
