import type { ReactNode } from 'react';

export interface ActivityItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}

export interface ActivityListProps {
  items: ActivityItem[];
  empty?: ReactNode;
  /** Draw a border around the list (used in cards that have their own padding). */
  bordered?: boolean;
}

/** Plain list of events with a right-aligned detail: coin history, a player's redemptions. */
export function ActivityList({ items, empty = 'Nothing here yet.', bordered }: ActivityListProps) {
  if (items.length === 0) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <ul
      className={
        bordered
          ? 'divide-y divide-border rounded-md border border-border'
          : 'divide-y divide-border'
      }
    >
      {items.map((it) => (
        <li
          key={it.id}
          className="flex flex-wrap items-center justify-between gap-3 px-1 py-2.5 text-sm"
        >
          <span className="min-w-0">
            <span className="block">{it.title}</span>
            {it.subtitle && <span className="block text-xs text-fg-muted">{it.subtitle}</span>}
          </span>
          {it.trailing && <span className="flex items-center gap-2">{it.trailing}</span>}
        </li>
      ))}
    </ul>
  );
}
