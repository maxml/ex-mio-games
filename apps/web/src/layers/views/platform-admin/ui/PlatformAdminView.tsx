'use client';

import { MioApiError, useAdminOverview, useMioMutation } from '@/layers/shared/api';
import type { ActAsTenantRequest } from '@/layers/shared/types';
import { AdminConsoleTemplate, Alert, Button, Page, Stack } from '@/layers/shared/ui';

/** MIO staff view across all operators. Opening an operator tenant needs a reason and is audited. */
export function PlatformAdminView() {
  const { data, isPending, isError, refetch } = useAdminOverview();
  const actAs = useMioMutation<ActAsTenantRequest>((a, r) => a.admin.actAsTenant(r));

  if (isPending) return <Page title="Platform admin">Loading...</Page>;
  if (isError || !data) {
    return (
      <Page title="Platform admin">
        <Stack gap={3} align="start">
          <Alert tone="danger">
            The overview could not be loaded. You may not have a platform role.
          </Alert>
          <Button variant="secondary" onClick={() => void refetch()}>
            Try again
          </Button>
        </Stack>
      </Page>
    );
  }

  const { tenants, funnel, audit } = data;
  const mrr = tenants.reduce((s, t) => s + t.mrr, 0);
  const spins = tenants.reduce((s, t) => s + t.spins, 0);
  const paying = tenants.filter((t) => t.mrr > 0).length;
  const first = funnel[0]?.value ?? 0;
  const lastStep = funnel[funnel.length - 1]?.value ?? 0;

  return (
    <AdminConsoleTemplate
      tiles={[
        { label: 'MRR', value: `${mrr.toLocaleString('en-US')} EUR`, delta: 8.2 },
        { label: 'Paying operators', value: `${paying} of ${tenants.length}` },
        { label: 'Spins this month', value: spins.toLocaleString('en-US'), delta: 14.9 },
        {
          label: 'Signup to paid',
          value: first > 0 ? `${((lastStep / first) * 100).toFixed(0)}%` : 'n/a',
          hint: 'last 30 days',
          delta: -1.3,
        },
      ]}
      tenants={tenants.map((t) => ({
        id: t.id,
        name: t.name,
        plan: t.plan,
        status: t.status,
        mrrEur: t.mrr,
        spins: t.spins,
        depositors: t.depositors,
      }))}
      funnel={funnel}
      minReason={8}
      acting={actAs.isPending}
      actError={actAs.error instanceof MioApiError ? actAs.error.message : undefined}
      onAct={(tenantId, reason) => actAs.mutateAsync({ tenantId, reason })}
      audit={audit.map((a) => ({
        id: a.id,
        title: `Opened ${tenants.find((t) => t.id === a.tenantId)?.name ?? a.tenantId}`,
        subtitle: `${a.reason} (${a.at})`,
      }))}
      copy={{
        intro: 'Our own view across all operators. Mock numbers.',
        tenantsTitle: 'Operators',
        tenantsDescription: 'Usage per operator, this month.',
        tenantColumn: 'Operator',
        currencyInHeader: true,
        actTitle: 'Open an operator tenant',
        actDescription: 'Every entry needs a reason and is written to the audit log.',
        tenantField: 'Operator',
        reasonHint: 'At least 8 characters, e.g. a ticket number and what you check.',
        actSubmit: 'Open tenant',
        funnelTitle: 'Operator funnel',
        funnelDescription: 'Where operators drop out between signup and first payment.',
      }}
    />
  );
}
