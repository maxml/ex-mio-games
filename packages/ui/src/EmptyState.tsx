import type { ReactNode } from 'react';
import { cn } from './cn';

export interface EmptyStateProps {
  title: string;
  /** One line that says what the person can do or when data will appear. */
  children?: ReactNode;
  /** Optional call to action (a Button or a Link). */
  action?: ReactNode;
  className?: string;
}

/** What a page shows when there is nothing to list yet: a title, one line, an optional action. */
export function EmptyState({ title, children, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-input-border bg-surface px-6 py-8 text-center',
        className,
      )}
    >
      <p className="font-display text-base font-semibold">{title}</p>
      {children && <p className="mt-1 text-sm text-fg-muted">{children}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
