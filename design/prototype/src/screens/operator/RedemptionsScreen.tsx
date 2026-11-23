import { useState } from 'react';
import { Alert, RedemptionsTemplate, type RedemptionRow } from '@ex-mio/ui';
import { REDEMPTIONS } from '../../mock/data';
import { useApp } from '../../state/store';
import { useOperatorShell } from './shell';

type RowStatus = RedemptionRow['status'];
const ROW_STATUSES: RowStatus[] = [
  'pending',
  'issuing',
  'needs_review',
  'issued',
  'failed',
  'failed_refunded',
  'refunded',
];
const rowStatus = (s: string): RowStatus => ROW_STATUSES.find((x) => x === s) ?? 'pending';

/** Operations: the redemption queue. Resolving a review has no service route behind the BFF yet: preview. */
export function RedemptionsScreen({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const mine = useApp((s) => s.player.redemptions);
  const [resolved, setResolved] = useState<string | null>(null);
  const rows: RedemptionRow[] = [
    ...mine.map((r) => ({
      id: r.id,
      player: 'p_you',
      item: r.item,
      priceCoins: r.coins,
      status: rowStatus(r.status),
      createdAt: 'Just now',
    })),
    ...REDEMPTIONS.map((r) => ({
      id: r.id,
      player: r.player,
      item: r.item,
      priceCoins: r.coins,
      status: rowStatus(r.status),
      createdAt: r.at,
    })),
  ];
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
      readOnly={readOnly}
      rows={rows}
      onResolve={(payload, id) =>
        setResolved(`${id}: ${payload.outcome === 'issued' ? 'Issued' : 'Not issued'}`)
      }
    />
  );
}
