import { ActivityList, type ActivityItem } from '../ActivityList';
import { BarChart, FunnelChart, type FunnelStep } from '../Charts';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';
import { InviteStaffForm } from '../InviteStaffForm';
import { InvoiceTable, type InvoiceRow } from '../InvoiceTable';
import { Grid, Stack } from '../Layout';
import { PreviewNotice } from '../Notices';
import { StatTile } from '../StatTile';
import { StatusPill, type Status } from '../StatusPill';
import { Table } from '../Table';
import { OperatorShell, ReadOnlyNotice, StateBody, type TemplateBase } from './OperatorShell';

export interface UsageStat {
  label: string;
  value: string;
  delta?: number;
}

export interface InsightsTemplateProps extends TemplateBase {
  usage: UsageStat[];
  daily: number[];
  invoices: InvoiceRow[];
  funnel: FunnelStep[];
  /** Pay an open invoice. A read role does not get the button. */
  onPay: (invoiceId: string) => void;
}

/** Insights: usage, invoices and the funnel. */
export function InsightsTemplate({
  shell,
  state,
  errorText,
  readOnly,
  usage,
  daily,
  invoices,
  funnel,
  onPay,
}: InsightsTemplateProps) {
  return (
    <OperatorShell
      {...shell}
      current="insights"
      title="Usage and invoices"
      intro="Spins, billing and the player funnel."
    >
      <StateBody
        state={state}
        errorText={errorText}
        empty={<EmptyState title="No spins this month yet." />}
      >
        <Stack gap={6}>
          {readOnly && <ReadOnlyNotice />}
          <Grid cols={3}>
            {usage.map((u) => (
              <StatTile key={u.label} label={u.label} value={u.value} delta={u.delta} />
            ))}
          </Grid>
          <Card title="Spins per day">
            <BarChart values={daily} label="Spins per day" />
          </Card>
          <Card title="Invoices" flush>
            <InvoiceTable invoices={invoices} onPay={readOnly ? undefined : onPay} />
          </Card>
          <Card title="Player funnel">
            <Stack>
              <PreviewNotice />
              <FunnelChart steps={funnel} />
            </Stack>
          </Card>
        </Stack>
      </StateBody>
    </OperatorShell>
  );
}

export interface StaffMember {
  id: string;
  email: string;
  role: string;
  status: Extract<Status, 'active' | 'pending'>;
}

export interface TeamTemplateProps extends TemplateBase {
  staff: StaffMember[];
  audit: ActivityItem[];
  onInvite: (email: string) => void;
}

/** Team and settings: staff list, invite, audit trail. All of it is preview until the routes exist. */
export function TeamTemplate({
  shell,
  state,
  errorText,
  readOnly,
  staff,
  audit,
  onInvite,
}: TeamTemplateProps) {
  return (
    <OperatorShell
      {...shell}
      current="team"
      title="Team and settings"
      intro="Who can open this console, and what changed."
    >
      <StateBody
        state={state}
        errorText={errorText}
        empty={
          <Stack>
            <PreviewNotice />
            <EmptyState title="Only you so far." />
          </Stack>
        }
      >
        <Stack gap={6}>
          <PreviewNotice />
          {readOnly && <ReadOnlyNotice />}
          <Card title="Staff" flush>
            <Table
              caption="Staff"
              rowKey={(s) => s.id}
              rows={staff}
              empty="Only you so far."
              columns={[
                { key: 'e', header: 'Email', render: (s) => s.email },
                { key: 'r', header: 'Role', render: (s) => s.role },
                { key: 's', header: 'Status', render: (s) => <StatusPill status={s.status} /> },
              ]}
            />
          </Card>
          {!readOnly && <InviteStaffForm onSubmit={onInvite} preview={false} />}
          <Card title="Audit trail">
            <ActivityList items={audit} empty="No changes recorded yet." />
          </Card>
        </Stack>
      </StateBody>
    </OperatorShell>
  );
}
