'use client';

import { useState } from 'react';
import { useMioMutation } from '@/layers/shared/api';
import {
  Alert,
  InsightsTemplate,
  RedemptionsTemplate,
  TeamTemplate,
  type ActivityItem,
  type FunnelStep,
  type InvoiceRow,
  type RedemptionRow,
  type StaffMember,
  type UsageStat,
} from '@/layers/shared/ui';
import { RequireAccess, useOperatorPage } from '../model/shell';

/** Operations: the redemption queue. Resolving a review has no BFF route yet, so it is a labelled preview. */
export function RedemptionsPage({ denied }: { denied?: string }) {
  return (
    <RequireAccess pageId="redemptions">
      {({ readOnly }) => <RedemptionsBody readOnly={readOnly} denied={denied} />}
    </RequireAccess>
  );
}

function RedemptionsBody({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { s, shell, state, errorText } = useOperatorPage('redemptions', denied);
  const [resolved, setResolved] = useState<string | null>(null);
  const rows: RedemptionRow[] = (s?.redemptions ?? []).map((r) => ({
    id: r.id,
    player: r.player,
    item: r.item,
    priceCoins: r.coins,
    status: r.status,
    createdAt: r.at,
  }));
  const notice = (
    <>
      {shell.notice}
      {resolved && (
        <Alert tone="info" live="status">
          Preview, not sent: {resolved}
        </Alert>
      )}
    </>
  );
  return (
    <RedemptionsTemplate
      shell={{ ...shell, notice }}
      state={state}
      errorText={errorText}
      readOnly={readOnly}
      rows={rows}
      onResolve={(payload, id) =>
        // Preview: engagement has `POST /v1/operator/redemptions/:id/resolve`, the BFF has no route for it.
        setResolved(`${id}: ${payload.outcome === 'issued' ? 'Issued' : 'Not issued'}`)
      }
    />
  );
}

// Preview: the operator funnel has no read API (Varta only, D-19), so these values are the mock's.
const PREVIEW_FUNNEL: FunnelStep[] = [
  { step: 'Widget opened', value: 1200 },
  { step: 'Deposited', value: 340 },
  { step: 'Spun', value: 310 },
  { step: 'Redeemed', value: 96 },
];

const eur = (n: number) => `${n.toLocaleString('en-US')}`;

/** Insights: usage, invoices and the funnel. Support reads it; the payments part answers without engagement. */
export function InsightsPage({ denied }: { denied?: string }) {
  return (
    <RequireAccess pageId="insights">
      {({ readOnly }) => <InsightsBody readOnly={readOnly} denied={denied} />}
    </RequireAccess>
  );
}

function InsightsBody({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { s, shell, state, errorText } = useOperatorPage('insights', denied);
  const pay = useMioMutation<void, unknown>((a) =>
    a.operator.startPayment(s?.plan ?? '', '4242', '4242424242424242'),
  );
  const usage: UsageStat[] = s
    ? [
        {
          label: 'Spins this month',
          value: eur(s.usage.spinsThisMonth),
        },
        { label: 'Included spins', value: eur(s.usage.included) },
        { label: 'Active players', value: eur(s.usage.activePlayers) },
      ]
    : [];
  const invoices: InvoiceRow[] = s
    ? [
        {
          id: s.invoice.period,
          period: s.invoice.period,
          amountEur: s.invoice.total,
          status: s.invoice.paid ? 'paid' : 'open',
        },
      ]
    : [];
  const empty = s !== undefined && s.usage.spinsThisMonth === 0;
  return (
    <InsightsTemplate
      shell={shell}
      state={state ?? (empty ? 'empty' : undefined)}
      errorText={errorText}
      readOnly={readOnly}
      usage={usage}
      daily={s?.usage.daily ?? []}
      invoices={invoices}
      funnel={PREVIEW_FUNNEL}
      onPay={() => pay.mutate()}
    />
  );
}

/** Team and settings: the staff list, invite and audit trail have no operator BFF route yet: all preview. */
export function TeamPage({ denied }: { denied?: string }) {
  return (
    <RequireAccess pageId="team">
      {({ readOnly }) => <TeamBody readOnly={readOnly} denied={denied} />}
    </RequireAccess>
  );
}

function TeamBody({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  // The team page needs no console state (it is all preview), so a failed state read is not its error.
  const { shell, errorText } = useOperatorPage('team', denied);
  const [invited, setInvited] = useState<string[]>([]);
  const staff: StaffMember[] = invited.map((email) => ({
    id: email,
    email,
    role: 'operator_staff',
    status: 'pending',
  }));
  const audit: ActivityItem[] = invited.map((email) => ({
    id: `invite-${email}`,
    title: `Invited ${email} (preview, not sent)`,
  }));
  return (
    <TeamTemplate
      shell={shell}
      errorText={errorText}
      readOnly={readOnly}
      staff={staff}
      audit={audit}
      onInvite={(email) => setInvited((cur) => [...cur, email])}
    />
  );
}
