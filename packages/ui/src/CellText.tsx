import type { ReactNode } from 'react';

/** Two-line table cell: the primary text, and a smaller muted line under it. */
export function CellText({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <span>
      <span className="block">{primary}</span>
      {secondary && <span className="block text-xs text-fg-muted">{secondary}</span>}
    </span>
  );
}
