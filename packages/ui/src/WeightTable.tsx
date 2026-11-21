import { CoinIcon } from './CoinBalance';
import { Input } from './Input';
import { Table } from './Table';

export interface WeightRow {
  id: string;
  coins: number;
}

export interface WeightTableProps {
  rows: WeightRow[];
  weights: number[];
  onChange: (index: number, weight: number) => void;
}

/** Wheel reward table: one editable weight per segment and the probability it implies. */
export function WeightTable({ rows, weights, onChange }: WeightTableProps) {
  const total = weights.reduce((a, b) => a + b, 0);
  return (
    <Table
      caption="Wheel segments"
      rowKey={(r) => r.id}
      rows={rows.map((r, i) => ({ ...r, i }))}
      columns={[
        {
          key: 'c',
          header: 'Reward',
          render: (r) => (
            <span className="inline-flex items-center gap-1.5">
              <CoinIcon className="size-4" />
              {r.coins} coins
            </span>
          ),
        },
        {
          key: 'w',
          header: 'Weight',
          align: 'right',
          render: (r) => {
            const w = weights[r.i] ?? NaN;
            return (
              <Input
                size="sm"
                className="w-24 text-right"
                aria-label={`Weight for ${r.coins} coins`}
                type="number"
                min={0.1}
                step={0.5}
                value={Number.isNaN(w) ? '' : w}
                invalid={!(w > 0)}
                onChange={(e) =>
                  onChange(r.i, e.target.value === '' ? NaN : Number(e.target.value))
                }
              />
            );
          },
        },
        {
          key: 'p',
          header: 'Probability',
          align: 'right',
          render: (r) =>
            total > 0 ? `${(((weights[r.i] ?? 0) / total) * 100).toFixed(1)}%` : 'n/a',
        },
      ]}
    />
  );
}
