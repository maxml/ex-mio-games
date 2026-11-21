'use client';

import { useRef, useState } from 'react';
import { useMioMutation } from '@/layers/shared/api';
import type { RedemptionStatus } from '@/layers/shared/types';
import {
  Alert,
  BarChart,
  Button,
  Card,
  CardForm,
  StatTile,
  StatusPill,
  Table,
  Text,
} from '@/layers/shared/ui';
import { STEPS, type StepProps } from './types';

type Filter = 'all' | RedemptionStatus;
const FILTERS: Filter[] = ['all', 'pending', 'issuing', 'issued', 'failed_refunded'];

export function RedemptionsStep({ s, nav }: StepProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = s.redemptions.filter((r) => filter === 'all' || r.status === filter);
  return (
    <div className="grid gap-4">
      <Card
        title="Redemptions"
        description="Each redemption is a promise to the player. Failed ones are refunded in coins automatically. Redemptions made in the player widget appear first."
        flush
      >
        <div
          className="flex flex-wrap gap-2 border-b border-border px-5 py-3"
          role="group"
          aria-label="Filter by status"
        >
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'primary' : 'secondary'}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>
        <Table
          caption="Redemptions"
          rowKey={(r) => r.id}
          rows={rows}
          empty="No redemptions with this status."
          columns={[
            { key: 'id', header: 'Id', render: (r) => r.id, hideOnMobile: true },
            { key: 'p', header: 'Player', render: (r) => r.player },
            {
              key: 'i',
              header: 'Item',
              render: (r) => (
                <span>
                  {r.item}
                  {r.note && <span className="block text-xs text-fg-muted">{r.note}</span>}
                </span>
              ),
            },
            {
              key: 'c',
              header: 'Coins',
              align: 'right',
              render: (r) => r.coins,
              hideOnMobile: true,
            },
            { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
            { key: 't', header: 'When', render: (r) => r.at, hideOnMobile: true },
          ]}
        />
      </Card>
      {nav()}
    </div>
  );
}

export function BillingStep({ s, nav }: StepProps) {
  const [paying, setPaying] = useState(false);
  const start = useMioMutation<{ last4: string; number?: string }, unknown>((a, c) =>
    a.operator.startPayment(s.plan, c.last4, c.number),
  );
  const card = useRef<string | undefined>(undefined);
  const cancel = useMioMutation<string>((a, id) => a.operator.cancelPayment(id));
  const [attempted, setAttempted] = useState(false);
  const inv = s.invoice;
  const open = STEPS.filter((x) => x.id !== 'billing' && !s.done[x.id]).map((x) => x.label);
  const processing = s.payment?.status === 'processing' || start.isPending;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Spins this month"
          value={s.usage.spinsThisMonth.toLocaleString('en-US')}
          hint={`of ${s.usage.included.toLocaleString('en-US')} included`}
          delta={12.4}
        />
        <StatTile
          label="Active players"
          value={s.usage.activePlayers.toLocaleString('en-US')}
          delta={6.1}
        />
        <StatTile
          label="Next invoice"
          value={`${inv.total} EUR`}
          hint={inv.paid ? 'paid for November' : 'due 30 Nov'}
        />
      </div>
      <Card title="Spins per day (last 14 days, thousands)">
        <BarChart label="Daily spins, thousands" values={s.usage.daily} />
      </Card>
      {(paying || processing) && !inv.paid ? (
        <CardForm
          amount={inv.total}
          description={`Invoice, ${inv.period}`}
          testMode
          processing={processing}
          failure={
            attempted && s.payment?.status === 'declined'
              ? 'The card was declined by the test provider. Use 4242 4242 4242 4242 instead.'
              : undefined
          }
          onSubmitCard={(digits) => {
            card.current = digits;
          }}
          onSubmit={(last4) => {
            setAttempted(true);
            start.mutate({ last4, number: card.current });
          }}
          onCancel={() => {
            if (s.payment?.status === 'processing') cancel.mutate(s.payment.id);
            setPaying(false);
          }}
        />
      ) : (
        <Card
          title={`Invoice, ${inv.period}`}
          actions={
            <>
              <StatusPill status={inv.paid ? 'paid' : 'open'} />
              {!inv.paid && (
                <Button size="sm" onClick={() => setPaying(true)}>
                  Pay invoice
                </Button>
              )}
            </>
          }
          flush
        >
          <Table
            caption="Invoice lines"
            rowKey={(l) => l.id}
            rows={inv.lines}
            columns={[
              { key: 'i', header: 'Item', render: (l) => l.item },
              { key: 'q', header: 'Qty', align: 'right', render: (l) => l.qty, hideOnMobile: true },
              {
                key: 'a',
                header: 'Amount (EUR)',
                align: 'right',
                render: (l) => l.amount.toFixed(2),
              },
            ]}
          />
          <Text strong className="flex justify-between border-t border-border px-4 py-3">
            <span>Total</span>
            <span className="tabular-nums">{inv.total.toFixed(2)} EUR</span>
          </Text>
          {inv.paid && (
            <Text tone="success" className="border-t border-border px-4 py-3" role="status">
              Paid with the test card ending {s.cardLast4}. Receipt sent (mock).
            </Text>
          )}
        </Card>
      )}
      {s.done.billing &&
        (open.length === 0 ? (
          <Alert tone="success">
            <span role="status">
              <strong>Setup complete.</strong> Plan paid, live, rules and wheel published.
            </span>
          </Alert>
        ) : (
          <Alert tone="warning">
            <span role="status">Finished, but these steps are still open: {open.join(', ')}.</span>
          </Alert>
        ))}
      {nav()}
    </div>
  );
}
