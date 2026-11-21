import { Button } from './Button';
import { CoinIcon } from './CoinBalance';
import { cn } from './cn';

export interface StoreItem {
  id: string;
  name: string;
  description: string;
  priceCoins: number;
  /** Remaining stock; undefined means unlimited. */
  stock?: number;
  kind: 'free_spins' | 'cash_bonus' | 'cashback' | 'merch';
}

export interface StoreItemCardProps {
  item: StoreItem;
  balance: number;
  busy?: boolean;
  onRedeem: (item: StoreItem) => void;
}

const KIND_LABEL: Record<StoreItem['kind'], string> = {
  free_spins: 'Free spins',
  cash_bonus: 'Cash bonus',
  cashback: 'Cashback',
  merch: 'Perk',
};

export function StoreItemCard({ item, balance, busy, onRedeem }: StoreItemCardProps) {
  const soldOut = item.stock !== undefined && item.stock <= 0;
  const missing = item.priceCoins - balance;
  const blocked = soldOut || missing > 0;
  const reasonId = `reason-${item.id}`;
  return (
    <article className="flex flex-col rounded-lg border border-border bg-surface p-4 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {KIND_LABEL[item.kind]}
      </p>
      <h3 className="mt-1 font-display text-base font-semibold">{item.name}</h3>
      <p className="mt-1 flex-1 text-sm text-fg-muted">{item.description}</p>
      <p className="mt-3 flex items-center gap-1.5 font-display text-lg font-bold tabular-nums">
        <CoinIcon /> {item.priceCoins.toLocaleString('en-US')}
      </p>
      <Button
        className="mt-3 w-full"
        variant={blocked ? 'secondary' : 'primary'}
        disabled={blocked}
        loading={busy}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => onRedeem(item)}
      >
        {soldOut ? 'Sold out' : 'Redeem'}
      </Button>
      <p
        id={reasonId}
        className={cn('mt-1.5 min-h-4 text-xs text-fg-muted', !blocked && 'invisible')}
      >
        {soldOut
          ? 'Out of stock'
          : missing > 0
            ? `${missing.toLocaleString('en-US')} more coins needed`
            : ''}
      </p>
    </article>
  );
}
