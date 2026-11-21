import type { ReactNode } from 'react';
import { Button } from './Button';

export interface KeyRowProps {
  label: string;
  /** The value, already masked by the caller when it is a secret. */
  value: string;
  onCopy?: () => void;
}

/** A credential row: label, monospaced value, optional copy button. Render inside `KeyList`. */
export function KeyRow({ label, value, onCopy }: KeyRowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <dt className="text-sm font-semibold">{label}</dt>
        <dd className="break-all font-mono text-sm text-fg-muted">{value}</dd>
      </div>
      {onCopy && (
        <Button size="sm" variant="secondary" onClick={onCopy} aria-label={`Copy ${label}`}>
          Copy
        </Button>
      )}
    </div>
  );
}

export function KeyList({ children }: { children: ReactNode }) {
  return <dl className="grid gap-4">{children}</dl>;
}
