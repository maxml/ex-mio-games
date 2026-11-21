'use client';

import { useState } from 'react';
import { MioApiError, useAdminOverview, useMioMutation } from '@/layers/shared/api';
import type { ActAsTenantRequest } from '@/layers/shared/types';
import {
  ActivityList,
  Alert,
  Button,
  Card,
  Field,
  FunnelChart,
  Input,
  Page,
  Select,
  StatTile,
  StatusPill,
  Table,
} from '@/layers/shared/ui';

/** MIO staff view across all operators. Opening an operator tenant needs a reason and is audited. */
export function PlatformAdminView() {
  const { data, isPending, isError, refetch } = useAdminOverview();
  const actAs = useMioMutation<ActAsTenantRequest>((a, r) => a.admin.actAsTenant(r));
  const [tenantId, setTenantId] = useState('');
  const [reason, setReason] = useState('');

  if (isPending) return <Page title="Platform admin">Loading...</Page>;
  if (isError || !data) {
    return (
      <Page title="Platform admin">
        <Alert tone="danger">
          The overview could not be loaded. You may not have a platform role.
        </Alert>
        <Button className="mt-3" variant="secondary" onClick={() => void refetch()}>
          Try again
        </Button>
      </Page>
    );
  }

  const { tenants, funnel, audit } = data;
  const mrr = tenants.reduce((s, t) => s + t.mrr, 0);
  const spins = tenants.reduce((s, t) => s + t.spins, 0);
  const paying = tenants.filter((t) => t.mrr > 0).length;
  const first = funnel[0]?.value ?? 0;
  const lastStep = funnel[funnel.length - 1]?.value ?? 0;
  const reasonShort = reason.trim().length < 8;
  const chosen = tenantId || tenants[0]?.id || '';

  return (
    <Page title="Platform admin" intro="Our own view across all operators. Mock numbers.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="MRR" value={`${mrr.toLocaleString('en-US')} EUR`} delta={8.2} />
        <StatTile label="Paying operators" value={`${paying} of ${tenants.length}`} />
        <StatTile label="Spins this month" value={spins.toLocaleString('en-US')} delta={14.9} />
        <StatTile
          label="Signup to paid"
          value={first > 0 ? `${((lastStep / first) * 100).toFixed(0)}%` : 'n/a'}
          hint="last 30 days"
          delta={-1.3}
        />
      </div>
      <Card className="mt-4" title="Operators" description="Usage per operator, this month." flush>
        <Table
          caption="Operators"
          rowKey={(t) => t.id}
          rows={tenants}
          columns={[
            {
              key: 'n',
              header: 'Operator',
              render: (t) => <span className="font-semibold">{t.name}</span>,
            },
            { key: 'p', header: 'Plan', render: (t) => t.plan, hideOnMobile: true },
            { key: 's', header: 'Status', render: (t) => <StatusPill status={t.status} /> },
            { key: 'm', header: 'MRR (EUR)', align: 'right', render: (t) => t.mrr },
            {
              key: 'u',
              header: 'Spins',
              align: 'right',
              render: (t) => t.spins.toLocaleString('en-US'),
              hideOnMobile: true,
            },
            {
              key: 'd',
              header: 'Depositors',
              align: 'right',
              render: (t) => t.depositors.toLocaleString('en-US'),
              hideOnMobile: true,
            },
          ]}
        />
      </Card>
      <Card
        className="mt-4"
        title="Open an operator tenant"
        description="Every entry needs a reason and is written to the audit log."
      >
        <form
          className="grid max-w-md gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reasonShort && chosen)
              actAs.mutate(
                { tenantId: chosen, reason: reason.trim() },
                { onSuccess: () => setReason('') },
              );
          }}
        >
          <Field label="Operator">
            {({ id }) => (
              <Select id={id} value={chosen} onChange={(e) => setTenantId(e.target.value)}>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Reason"
            hint="At least 8 characters, e.g. a ticket number and what you check."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <div>
            <Button type="submit" disabled={reasonShort} loading={actAs.isPending}>
              Open tenant
            </Button>
          </div>
          {actAs.error instanceof MioApiError && <Alert tone="danger">{actAs.error.message}</Alert>}
        </form>
        <ActivityList
          items={audit.map((a) => ({
            id: a.id,
            title: `Opened ${tenants.find((t) => t.id === a.tenantId)?.name ?? a.tenantId}`,
            subtitle: `${a.reason} (${a.at})`,
          }))}
          empty="No tenant has been opened yet."
        />
      </Card>
      <Card
        className="mt-4"
        title="Operator funnel"
        description="Where operators drop out between signup and first payment."
      >
        <FunnelChart steps={funnel} />
      </Card>
    </Page>
  );
}
