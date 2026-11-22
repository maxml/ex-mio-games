import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type Gap = 1 | 2 | 3 | 4 | 6 | 8;
const GAP: Record<Gap, string> = {
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  6: 'gap-6',
  8: 'gap-8',
};

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  gap?: Gap;
  /** Lay the children out in a row (wrapping) instead of a column. */
  row?: boolean;
  align?: 'start' | 'center' | 'end';
  justify?: 'start' | 'between' | 'end';
}

const ALIGN = { start: 'items-start', center: 'items-center', end: 'items-end' } as const;
const JUSTIFY = {
  start: 'justify-start',
  between: 'justify-between',
  end: 'justify-end',
} as const;

/** Vertical (or wrapping horizontal) flow with a token-sized gap. Replaces ad-hoc flex wrappers. */
export function Stack({ gap = 4, row, align, justify, className, ...rest }: StackProps) {
  return (
    <div
      className={cn(
        'flex min-w-0',
        row ? 'flex-row flex-wrap' : 'flex-col',
        GAP[gap],
        align && ALIGN[align],
        justify && JUSTIFY[justify],
        className,
      )}
      {...rest}
    />
  );
}

const COLS = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
} as const;

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  gap?: Gap;
  /** Columns at the widest breakpoint; the grid collapses on narrow screens. */
  cols?: keyof typeof COLS;
}

/** Responsive equal-width grid. */
export function Grid({ gap = 4, cols = 2, className, ...rest }: GridProps) {
  return <div className={cn('grid min-w-0', COLS[cols], GAP[gap], className)} {...rest} />;
}
