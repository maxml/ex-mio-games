import { useState, type ReactNode } from 'react';
import { Button } from './Button';

export interface KeyRowProps {
  label: string;
  /** The value. With `secret` it is the real value and the row masks it; otherwise show it as is. */
  value: string;
  /** Masked by default, with a Reveal / Hide toggle. Use it for every secret key. */
  secret?: boolean;
  onCopy?: () => void;
}

const MASK = '•'.repeat(24);

/** A credential row: label, monospaced value, optional reveal and copy buttons. Render inside `KeyList`. */
export function KeyRow({ label, value, secret, onCopy }: KeyRowProps) {
  const [shown, setShown] = useState(false);
  const visible = !secret || shown;
  return (
    <div>
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all font-mono text-sm text-fg-muted">
          {visible ? value : MASK}
        </span>
        <span className="flex gap-2">
          {secret && (
            <Button
              size="sm"
              variant="secondary"
              aria-label={`${shown ? 'Hide' : 'Reveal'} ${label}`}
              onClick={() => setShown((s) => !s)}
            >
              {shown ? 'Hide' : 'Reveal'}
            </Button>
          )}
          {onCopy && (
            <Button size="sm" variant="secondary" onClick={onCopy} aria-label={`Copy ${label}`}>
              Copy
            </Button>
          )}
        </span>
      </dd>
    </div>
  );
}

export function KeyList({ children }: { children: ReactNode }) {
  return <dl className="grid gap-4">{children}</dl>;
}
