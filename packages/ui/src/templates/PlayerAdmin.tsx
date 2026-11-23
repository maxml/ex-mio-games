import { useState, type ReactNode } from 'react';
import { ActivityList, type ActivityItem } from '../ActivityList';
import { Button } from '../Button';
import { Card } from '../Card';
import { FunnelChart, type FunnelStep } from '../Charts';
import { CoinBalance } from '../CoinBalance';
import { EmptyState } from '../EmptyState';
import { Field, Input, Select } from '../Input';
import { LiveRegion } from '../Landmarks';
import { Grid, Stack } from '../Layout';
import { RedeemFlow, type RedeemStatus } from '../RedeemFlow';
import { SpinPanel } from '../SpinPanel';
import { StatTile, type StatTileProps } from '../StatTile';
import { Badge, StatusPill, type Status } from '../StatusPill';
import type { StoreItem } from '../StoreItemCard';
import { Table } from '../Table';
import { TabPanel, Tabs } from '../Tabs';
import { Alert } from '../Toast';
import { Heading } from '../Typography';
import type { WheelSegment, WheelSpin } from '../Wheel';
import { StateBody, type Environment, type PageState } from './OperatorShell';

type WidgetTab = 'wheel' | 'store' | 'history';
const WIDGET_TABS: { id: WidgetTab; label: string }[] = [
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Bonus Store' },
  { id: 'history', label: 'History' },
];

export interface PlayerWidgetTemplateProps {
  state?: PageState;
  errorText?: string;
  /** The environment badge of the full-page layout. Not drawn when `embedded` or when unset. */
  environment?: Environment;
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
  /** Ask "Redeem X for N coins?" before `onRedeem` (default). Off: the Redeem button redeems at once. */
  confirmRedeem?: boolean;
  /**
   * The casino-page layout: a card with the balance in its header and Wheel / Bonus Store / History
   * tabs, instead of the full page of cards. The result is announced from one always-mounted live region,
   * so it is heard from any tab.
   */
  embedded?: { ariaLabel: string; title: string; description?: string };
  /** Next to the balance, for example "+40 pending". */
  balanceNote?: ReactNode;
  /** The player's redemptions, listed under the store as "Your redemptions". */
  redemptions?: ActivityItem[];
  /** A transient message above the content, for example a Toast. */
  notice?: ReactNode;
  /** Below the wheel (sandbox-casino demo controls). */
  wheelExtra?: ReactNode;
  /** Above the store items. */
  storeExtra?: ReactNode;
  /** `data-testid` of the live result region of the embedded layout. */
  resultTestId?: string;
}

/** The player widget: balance, spin, store and history. Full page by default, or `embedded` as tabs. */
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
  confirmRedeem,
  embedded,
  balanceNote,
  redemptions,
  notice,
  wheelExtra,
  storeExtra,
  resultTestId,
}: PlayerWidgetTemplateProps) {
  const [tab, setTab] = useState<WidgetTab>('wheel');
  const spinPanel = (
    <SpinPanel
      segments={segments}
      spin={spin}
      result={result}
      spinsLeft={spinsLeft}
      busy={busy}
      onSpin={onSpin}
      onSpinEnd={onSpinEnd}
      size={280}
      live={!embedded}
    />
  );
  const storeGrid = (
    <Grid cols={2}>
      {items.map((item) => (
        <RedeemFlow
          key={item.id}
          item={item}
          balance={balance}
          status={redeemStatus[item.id]}
          onConfirm={onRedeem}
          confirm={confirmRedeem}
        />
      ))}
    </Grid>
  );
  const yourRedemptions = redemptions && (
    <>
      <Heading level={3}>Your redemptions</Heading>
      <ActivityList bordered empty="Nothing redeemed yet." items={redemptions} />
    </>
  );
  const historyList = <ActivityList items={history} empty="No activity yet." />;

  const empty = (
    <EmptyState title="Nothing to redeem yet">
      The store and your history appear here once the operator adds items.
    </EmptyState>
  );

  if (embedded) {
    return (
      <Card
        aria-label={embedded.ariaLabel}
        title={embedded.title}
        actions={
          <Stack row gap={2} align="center">
            <CoinBalance coins={balance} />
            {balanceNote}
          </Stack>
        }
        description={embedded.description}
      >
        {/* Always mounted, so the result is announced even when the Wheel tab is not showing. */}
        <LiveRegion data-testid={resultTestId}>{result}</LiveRegion>
        <StateBody state={state} errorText={errorText} empty={empty}>
          <Stack gap={4}>
            <Tabs
              tabs={WIDGET_TABS}
              value={tab}
              onChange={setTab}
              label="Widget sections"
              idPrefix="pw"
            />
            {notice}
            {tab === 'wheel' && (
              <TabPanel idPrefix="pw" id="wheel">
                <Stack gap={3}>
                  {spinPanel}
                  {wheelExtra}
                </Stack>
              </TabPanel>
            )}
            {tab === 'store' && (
              <TabPanel idPrefix="pw" id="store">
                <Stack gap={3}>
                  {storeExtra}
                  {storeGrid}
                  {yourRedemptions}
                </Stack>
              </TabPanel>
            )}
            {tab === 'history' && (
              <TabPanel idPrefix="pw" id="history">
                {historyList}
              </TabPanel>
            )}
          </Stack>
        </StateBody>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <Stack gap={6}>
        <Stack row align="center" justify="between">
          <Heading level={1}>Wheel of Fortune</Heading>
          {environment && (
            <Badge tone={environment === 'live' ? 'success' : 'warning'} icon>
              {environment === 'live' ? 'Live' : 'Sandbox'}
            </Badge>
          )}
        </Stack>
        <StateBody state={state} errorText={errorText} empty={empty}>
          <Stack row gap={2} align="center">
            <CoinBalance coins={balance} size="lg" />
            {balanceNote}
          </Stack>
          {notice}
          <Card title="Spin">
            <Stack gap={3}>
              {spinPanel}
              {wheelExtra}
            </Stack>
          </Card>
          <Card title="Store">
            <Stack gap={3}>
              {storeExtra}
              {storeGrid}
              {yourRedemptions}
            </Stack>
          </Card>
          <Card title="History">{historyList}</Card>
        </StateBody>
      </Stack>
    </div>
  );
}

export interface TenantRow {
  id: string;
  name: string;
  /** The plan's name, for example "Growth". */
  plan: string;
  status: Extract<Status, 'active' | 'trial' | 'past_due' | 'suspended'>;
  mrrEur: number;
  /** When any tenant has them, the table gains Spins and Depositors columns (hidden on a phone). */
  spins?: number;
  depositors?: number;
}

/** Words of the admin page. Every key is optional: the default is the platform-admin wording. */
export interface AdminConsoleCopy {
  title?: string;
  intro?: string;
  tenantsTitle?: string;
  tenantsDescription?: string;
  tenantColumn?: string;
  /** Put the currency in the MRR column header ("MRR (EUR)") and show bare numbers in its cells. */
  currencyInHeader?: boolean;
  actTitle?: string;
  actDescription?: string;
  tenantField?: string;
  reasonHint?: string;
  actSubmit?: string;
  funnelTitle?: string;
  funnelDescription?: string;
}

export interface AdminConsoleTemplateProps {
  state?: PageState;
  errorText?: string;
  tenants: TenantRow[];
  funnel: FunnelStep[];
  /** A role that cannot start an acting session gets no act-as form. */
  readOnly?: boolean;
  /**
   * Start an acting session on a tenant. The reason is required. When it returns a promise, the reason
   * is cleared once that resolves (and kept if it rejects).
   */
  onAct: (tenantId: string, reason: string) => unknown;
  /** Replaces the three default tiles (tenants, MRR, past due). Four tiles make a four-column row. */
  tiles?: StatTileProps[];
  /** Fewest characters of reason (default 3). The most is 500. */
  minReason?: number;
  /** The act-as request is in flight. */
  acting?: boolean;
  /** Why the act-as request failed. */
  actError?: string;
  /** Sessions already opened, newest first. Drawn under the form when given. */
  audit?: ActivityItem[];
  copy?: AdminConsoleCopy;
}

/** Platform admin: tenants, MRR, the platform funnel and the act-as form. */
export function AdminConsoleTemplate({
  state,
  errorText,
  tenants,
  funnel,
  readOnly,
  onAct,
  tiles,
  minReason = 3,
  acting,
  actError,
  audit,
  copy = {},
}: AdminConsoleTemplateProps) {
  const [tenantId, setTenantId] = useState('');
  const [reason, setReason] = useState('');
  const chosen = tenantId || tenants[0]?.id || '';
  const mrr = tenants.reduce((sum, t) => sum + t.mrrEur, 0);
  const reasonOk = reason.trim().length >= minReason && reason.trim().length <= 500;
  const showUsage = tenants.some((t) => t.spins !== undefined || t.depositors !== undefined);
  const shownTiles = tiles ?? [
    { label: 'Tenants', value: tenants.length },
    { label: 'MRR', value: `${mrr} EUR` },
    { label: 'Past due', value: tenants.filter((t) => t.status === 'past_due').length },
  ];
  const mrrHeader = copy.currencyInHeader ? 'MRR (EUR)' : 'MRR';
  return (
    <div className="mx-auto max-w-5xl p-4">
      <Stack gap={6}>
        <Stack gap={1}>
          <Heading level={1}>{copy.title ?? 'Platform admin'}</Heading>
          {copy.intro && <p className="text-sm text-fg-muted">{copy.intro}</p>}
        </Stack>
        <StateBody
          state={state}
          errorText={errorText}
          empty={
            <EmptyState title="No tenants yet.">
              Operators appear here after they sign up.
            </EmptyState>
          }
        >
          <Grid cols={shownTiles.length === 4 ? 4 : 3} gap={3}>
            {shownTiles.map((t) => (
              <StatTile key={t.label} {...t} />
            ))}
          </Grid>
          <Card title={copy.tenantsTitle ?? 'Tenants'} description={copy.tenantsDescription} flush>
            <Table
              caption={copy.tenantsTitle ?? 'Tenants'}
              rowKey={(t) => t.id}
              rows={tenants}
              columns={[
                { key: 'n', header: copy.tenantColumn ?? 'Tenant', render: (t) => t.name },
                { key: 'p', header: 'Plan', render: (t) => t.plan, hideOnMobile: showUsage },
                { key: 's', header: 'Status', render: (t) => <StatusPill status={t.status} /> },
                {
                  key: 'm',
                  header: mrrHeader,
                  align: 'right',
                  render: (t) => (copy.currencyInHeader ? t.mrrEur : `${t.mrrEur} EUR`),
                },
                ...(showUsage
                  ? [
                      {
                        key: 'u',
                        header: 'Spins',
                        align: 'right' as const,
                        render: (t: TenantRow) => (t.spins ?? 0).toLocaleString('en-US'),
                        hideOnMobile: true,
                      },
                      {
                        key: 'd',
                        header: 'Depositors',
                        align: 'right' as const,
                        render: (t: TenantRow) => (t.depositors ?? 0).toLocaleString('en-US'),
                        hideOnMobile: true,
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
          {!readOnly && (
            <Card
              title={copy.actTitle ?? 'Act as an operator'}
              description={
                copy.actDescription ??
                'Starts an audited session of at most 15 minutes. A reason is required.'
              }
            >
              <Stack gap={4}>
                <form
                  className="grid max-w-md gap-4"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!reasonOk || !chosen) return;
                    const out = onAct(chosen, reason.trim());
                    if (out instanceof Promise)
                      out.then(
                        () => setReason(''),
                        () => undefined,
                      );
                  }}
                >
                  <Field label={copy.tenantField ?? 'Tenant'}>
                    {({ id }) => (
                      <Select
                        id={id}
                        value={chosen}
                        onChange={(e) => setTenantId(e.target.value)}
                        options={tenants.map((t) => ({ value: t.id, label: t.name }))}
                      />
                    )}
                  </Field>
                  <Field label="Reason" hint={copy.reasonHint ?? '3 to 500 characters.'}>
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
                    <Button type="submit" disabled={!reasonOk || !chosen} loading={acting}>
                      {copy.actSubmit ?? 'Start acting session'}
                    </Button>
                  </div>
                  {actError && <Alert tone="danger">{actError}</Alert>}
                </form>
                {audit && <ActivityList items={audit} empty="No tenant has been opened yet." />}
              </Stack>
            </Card>
          )}
          <Card title={copy.funnelTitle ?? 'Platform funnel'} description={copy.funnelDescription}>
            <FunnelChart steps={funnel} />
          </Card>
        </StateBody>
      </Stack>
    </div>
  );
}
