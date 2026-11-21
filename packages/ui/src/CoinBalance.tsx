import { cn } from './cn';

export interface CoinBalanceProps {
  coins: number;
  /** Announce changes to screen readers (balance after a spin or a purchase). */
  live?: boolean;
  size?: 'md' | 'lg';
  className?: string;
}

export function CoinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cn('size-5 shrink-0', className)} aria-hidden>
      <circle cx="10" cy="10" r="9" style={{ fill: 'var(--coin)' }} />
      <circle
        cx="10"
        cy="10"
        r="6"
        style={{ fill: 'none', stroke: 'var(--surface)', strokeWidth: 1.5 }}
      />
    </svg>
  );
}

export function CoinBalance({ coins, live = true, size = 'md', className }: CoinBalanceProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 font-display font-bold tabular-nums',
        size === 'lg' ? 'text-3xl' : 'text-xl',
        className,
      )}
      role="status"
      aria-live={live ? 'polite' : 'off'}
    >
      <CoinIcon className={size === 'lg' ? 'size-8' : 'size-6'} />
      <span>{coins.toLocaleString('en-US')}</span>
      <span className="sr-only">coins</span>
    </div>
  );
}
