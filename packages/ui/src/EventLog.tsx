import type { ReactNode } from 'react';
import { StatusPill, type Status } from './StatusPill';

export interface EventLogEntry {
  id: string;
  label: string;
  detail: string;
  status: Status;
}

export interface EventLogProps {
  entries: EventLogEntry[];
  empty?: ReactNode;
}

/** Ordered test or event log. It is a live region so a new line is announced as it appears. */
export function EventLog({ entries, empty = 'Not run yet.' }: EventLogProps) {
  return (
    <ol className="grid gap-2" aria-live="polite">
      {entries.map((e) => (
        <li
          key={e.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
        >
          <span>
            <span className="font-semibold">{e.label}</span>{' '}
            <span className="text-fg-muted">{e.detail}</span>
          </span>
          <StatusPill status={e.status} />
        </li>
      ))}
      {entries.length === 0 && <li className="text-sm text-fg-muted">{empty}</li>}
    </ol>
  );
}
