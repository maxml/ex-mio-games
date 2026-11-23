import { useState } from 'react';
import { Button } from './Button';
import { StatusPill } from './StatusPill';
import { StoreItemCard, type StoreItem } from './StoreItemCard';
import { Alert } from './Toast';

export type RedeemStatus = 'pending' | 'issued' | 'failed_refunded';

export interface RedeemFlowProps {
  item: StoreItem;
  balance: number;
  /** The redemption's status once it was submitted. Comes from the server; the flow only shows it. */
  status?: RedeemStatus;
  /** The player confirmed. The caller creates the redemption (with its idempotency key). */
  onConfirm: (item: StoreItem) => void;
  /** Ask "Redeem X for N coins?" first (default). Off: the Redeem button confirms at once. */
  confirm?: boolean;
}

/** Redeem -> confirm -> pending -> issued, or failed and refunded. Presentational: status is a prop. */
export function RedeemFlow({ item, balance, status, onConfirm, confirm = true }: RedeemFlowProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="grid gap-2">
      <StoreItemCard
        item={item}
        balance={balance}
        busy={status === 'pending'}
        onRedeem={() => (confirm ? setConfirming(true) : onConfirm(item))}
      />
      {confirming && !status && (
        <Alert tone="warning" live="alert">
          <p className="mb-2">
            Redeem {item.name} for {item.priceCoins.toLocaleString('en-US')} coins?
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
                onConfirm(item);
              }}
            >
              Confirm
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Alert>
      )}
      <div role="status" aria-live="polite" className="min-h-6 text-sm">
        {status === 'pending' && <StatusPill status="pending" />}
        {status === 'issued' && <StatusPill status="issued" />}
        {status === 'failed_refunded' && (
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status="refunded" />
            <span>
              Your {item.priceCoins.toLocaleString('en-US')} coins are back in your balance.
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
