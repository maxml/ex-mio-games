import { useState } from 'react';
import { Button } from '../Button';
import { Card } from '../Card';
import { CellText } from '../CellText';
import { EmptyState } from '../EmptyState';
import { FilterBar } from '../FilterBar';
import { Stack } from '../Layout';
import { ResolvePanel, type ResolveReviewPayload } from '../ResolvePanel';
import { StatusPill, type Status } from '../StatusPill';
import { Table } from '../Table';
import { OperatorShell, ReadOnlyNotice, StateBody, type TemplateBase } from './OperatorShell';

export interface RedemptionRow {
  id: string;
  player: string;
  item: string;
  priceCoins: number;
  status: Extract<
    Status,
    'pending' | 'issuing' | 'needs_review' | 'issued' | 'failed' | 'failed_refunded' | 'refunded'
  >;
  createdAt: string;
}

export type RedemptionFilter = 'all' | 'pending' | 'needs_review' | 'issued' | 'failed';

const FILTERS: { value: RedemptionFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'issued', label: 'Issued' },
  { value: 'failed', label: 'Failed' },
];

const matches = (f: RedemptionFilter, s: RedemptionRow['status']) =>
  f === 'all' || (f === 'failed' ? s === 'failed' || s === 'failed_refunded' : s === f);

export interface RedemptionsTemplateProps extends TemplateBase {
  rows: RedemptionRow[];
  /** Called with the engagement `ResolveReviewRequest` and the redemption id. */
  onResolve: (payload: ResolveReviewPayload, redemptionId: string) => void;
  busy?: boolean;
}

/** Operations: the redemption queue by status; open a review row and resolve it. */
export function RedemptionsTemplate({
  shell,
  state,
  errorText,
  readOnly,
  rows,
  onResolve,
  busy,
}: RedemptionsTemplateProps) {
  const [filter, setFilter] = useState<RedemptionFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.id === openId && r.status === 'needs_review');
  const shown = rows.filter((r) => matches(filter, r.status));
  return (
    <OperatorShell
      {...shell}
      current="redemptions"
      title="Redemptions"
      intro="Players' store redemptions, newest first."
    >
      <StateBody
        state={state}
        errorText={errorText}
        empty={
          <EmptyState title="No redemptions yet.">
            They appear here when players redeem in the widget.
          </EmptyState>
        }
      >
        <Stack gap={6}>
          {rows.length === 0 ? (
            <EmptyState title="No redemptions yet.">
              They appear here when players redeem in the widget.
            </EmptyState>
          ) : (
            <Card title="Queue" flush>
              <div className="px-5 py-3">
                <FilterBar options={FILTERS} value={filter} onChange={setFilter} />
              </div>
              <Table
                caption="Redemptions"
                rowKey={(r) => r.id}
                rows={shown}
                empty="No redemptions with this status."
                columns={[
                  {
                    key: 'p',
                    header: 'Player',
                    render: (r) => <CellText primary={r.player} secondary={r.createdAt} />,
                  },
                  {
                    key: 'i',
                    header: 'Item',
                    render: (r) => (
                      <CellText
                        primary={r.item}
                        secondary={`${r.priceCoins.toLocaleString('en-US')} coins`}
                      />
                    ),
                  },
                  { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
                  ...(readOnly
                    ? []
                    : [
                        {
                          key: 'a',
                          header: 'Action',
                          render: (r: RedemptionRow) =>
                            r.status === 'needs_review' ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                aria-label={`Resolve ${r.id}`}
                                onClick={() => setOpenId(r.id)}
                              >
                                Resolve
                              </Button>
                            ) : null,
                        },
                      ]),
                ]}
              />
            </Card>
          )}
          {!readOnly && open && (
            <ResolvePanel
              redemptionLabel={`${open.item} for ${open.player}`}
              preview
              busy={busy}
              onCancel={() => setOpenId(null)}
              onResolve={(payload) => {
                onResolve(payload, open.id);
                setOpenId(null);
              }}
            />
          )}
          {readOnly && <ReadOnlyNotice />}
        </Stack>
      </StateBody>
    </OperatorShell>
  );
}
