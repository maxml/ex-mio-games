import { useState } from 'react';
import { ActivityList, type ActivityItem } from '../ActivityList';
import { Button } from '../Button';
import { Card } from '../Card';
import { FunnelChart, type FunnelStep } from '../Charts';
import { CoinBalance } from '../CoinBalance';
import { EmptyState } from '../EmptyState';
import { Field, Input, Select } from '../Input';
import { Grid, Stack } from '../Layout';
import { RedeemFlow, type RedeemStatus } from '../RedeemFlow';
import { SpinPanel } from '../SpinPanel';
import { StatTile } from '../StatTile';
import { Badge, StatusPill, type Status } from '../StatusPill';
import type { StoreItem } from '../StoreItemCard';
import { Table } from '../Table';
import { Heading } from '../Typography';
import type { WheelSegment, WheelSpin } from '../Wheel';
import { StateBody, type Environment, type PageState } from './OperatorShell';

export interface PlayerWidgetTemplateProps {
  state?: PageState;
  errorText?: string;
  environment: Environment;
  balance: number;
  spinsLeft: number;
  segments: WheelSegment[];
  spin: WheelSpin | null;
  /** Announced when the wheel stops. */
  result?: string;
  busy?: boolean;
  onSpin: () => void;
  onSpinEnd?: (spinId: string) => void;
  items: StoreItem[];
  /** Status of the redemption per item id, from the server. */
  redeemStatus?: Record<string, RedeemStatus>;
  onRedeem: (item: StoreItem) => void;
  history: ActivityItem[];
}

/** The embedded player widget: balance, spin, store and history. */
export function PlayerWidgetTemplate({
  state,
  errorText,
  environment,
  balance,
  spinsLeft,
  segments,
  spin,
  result,
  busy,
  onSpin,
  onSpinEnd,
  items,
  redeemStatus = {},
  onRedeem,
  history,
}: PlayerWidgetTemplateProps) {
  return (
    <div className="mx-auto max-w-3xl p-4">
      <Stack gap={6}>
        <Stack row align="center" justify="between">
          <Heading level={1}>Wheel of Fortune</Heading>
          <Badge tone={environment === 'live' ? 'success' : 'warning'} icon>
            {environment === 'live' ? 'Live' : 'Sandbox'}
          </Badge>
        </Stack>
        <StateBody
          state={state}
          errorText={errorText}
          empty={
            <EmptyState title="Nothing to redeem yet">
              The store and your history appear here once the operator adds items.
            </EmptyState>
          }
        >
          <CoinBalance coins={balance} size="lg" />
          <Card title="Spin">
            <SpinPanel
              segments={segments}
              spin={spin}
              result={result}
              spinsLeft={spinsLeft}
              busy={busy}
              onSpin={onSpin}
              onSpinEnd={onSpinEnd}
              size={280}
            />
          </Card>
          <Card title="Store">
            <Grid cols={2}>
              {items.map((item) => (
                <RedeemFlow
                  key={item.id}
                  item={item}
                  balance={balance}
                  status={redeemStatus[item.id]}
                  onConfirm={onRedeem}
                />
              ))}
            </Grid>
          </Card>
          <Card title="History">
            <ActivityList items={history} empty="No activity yet." />
          </Card>
        </StateBody>
      </Stack>
    </div>
  );
}

export interface TenantRow {
  id: string;
  name: string;
  plan: Extract<Status, 'active' | 'trial' | 'past_due' | 'suspended'>;
  status: Extract<Status, 'active' | 'trial' | 'past_due' | 'suspended'>;
  mrrEur: number;
}

export interface AdminConsoleTemplateProps {
  state?: PageState;
  errorText?: string;
  tenants: TenantRow[];
  funnel: FunnelStep[];
  /** A role that cannot start an acting session gets no act-as form. */
  readOnly?: boolean;
  /** Start an acting session on a tenant. The reason is required (3 to 500 characters). */
  onAct: (tenantId: string, reason: string) => void;
}

/** Platform admin: tenants, MRR, the platform funnel and the act-as form. */
export function AdminConsoleTemplate({
  state,
  errorText,
  tenants,
  funnel,
  readOnly,
  onAct,
}: AdminConsoleTemplateProps) {
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const mrr = tenants.reduce((sum, t) => sum + t.mrrEur, 0);
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  return (
    <div className="mx-auto max-w-5xl p-4">
      <Stack gap={6}>
        <Heading level={1}>Platform admin</Heading>
        <StateBody
          state={state}
          errorText={errorText}
          empty={
            <EmptyState title="No tenants yet.">
              Operators appear here after they sign up.
            </EmptyState>
          }
        >
          <Grid cols={3}>
            <StatTile label="Tenants" value={tenants.length} />
            <StatTile label="MRR" value={`${mrr} EUR`} />
            <StatTile
              label="Past due"
              value={tenants.filter((t) => t.status === 'past_due').length}
            />
          </Grid>
          <Card title="Tenants" flush>
            <Table
              caption="Tenants"
              rowKey={(t) => t.id}
              rows={tenants}
              columns={[
                { key: 'n', header: 'Tenant', render: (t) => t.name },
                { key: 'p', header: 'Plan', render: (t) => <StatusPill status={t.plan} /> },
                { key: 's', header: 'Status', render: (t) => <StatusPill status={t.status} /> },
                { key: 'm', header: 'MRR', align: 'right', render: (t) => `${t.mrrEur} EUR` },
              ]}
            />
          </Card>
          <Card title="Platform funnel">
            <FunnelChart steps={funnel} />
          </Card>
          {!readOnly && (
            <Card
              title="Act as an operator"
              description="Starts an audited session of at most 15 minutes. A reason is required."
            >
              <form
                className="grid max-w-md gap-4"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reasonOk && tenantId) onAct(tenantId, reason.trim());
                }}
              >
                <Field label="Tenant">
                  {({ id }) => (
                    <Select id={id} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Reason" hint="3 to 500 characters.">
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  )}
                </Field>
                <div>
                  <Button type="submit" disabled={!reasonOk || !tenantId}>
                    Start acting session
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </StateBody>
      </Stack>
    </div>
  );
}
