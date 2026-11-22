import type { ReactNode } from 'react';
import { cn } from './cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Hide below the sm breakpoint to keep narrow screens readable. */
  hideOnMobile?: boolean;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  empty?: ReactNode;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty = 'Nothing here yet.',
}: TableProps<T>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-fg-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'px-4 py-2.5 font-semibold',
                  c.align === 'right' && 'text-right',
                  c.hideOnMobile && 'hidden sm:table-cell',
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-fg-muted">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-border last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-4 py-3 align-middle',
                    c.align === 'right' && 'text-right tabular-nums',
                    c.hideOnMobile && 'hidden sm:table-cell',
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
