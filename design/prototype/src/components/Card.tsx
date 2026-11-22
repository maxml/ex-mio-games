import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Right side of the header: buttons, badges. */
  actions?: ReactNode;
  /** Remove body padding (for tables that run edge to edge). */
  flush?: boolean;
}

export function Card({
  title,
  description,
  actions,
  flush,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-lg border border-border bg-surface text-fg shadow-card',
        className,
      )}
      {...rest}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="font-display text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}
