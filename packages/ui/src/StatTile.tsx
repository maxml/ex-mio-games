import type { ReactNode } from 'react';
import { cn } from './cn';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Change versus the previous period, e.g. +12.4 means +12.4 %. */
  delta?: number;
  hint?: ReactNode;
  className?: string;
}

export function StatTile({ label, value, delta, hint, className }: StatTileProps) {
  const up = delta !== undefined && delta >= 0;
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-4 shadow-card', className)}>
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold tabular-nums">{value}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        {delta !== undefined && (
          <span className={cn('font-semibold', up ? 'text-success' : 'text-danger')}>
            <span aria-hidden>{up ? '▲' : '▼'}</span>
            <span className="sr-only">{up ? 'up' : 'down'}</span> {Math.abs(delta).toFixed(1)}%
          </span>
        )}
        {hint && <span className="text-fg-muted">{hint}</span>}
      </div>
    </div>
  );
}
