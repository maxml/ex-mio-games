import type { ReactNode } from 'react';
import { cn } from './cn';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';
const TONE: Record<AlertTone, string> = {
  info: 'border-info text-info',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
};
const ICON: Record<AlertTone, string> = { info: 'i', success: '✓', warning: '!', danger: '✕' };

/** A static message box. The icon and a word-level message carry the meaning, not the colour. */
export function Alert({
  tone = 'info',
  children,
  className,
}: {
  tone?: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border bg-surface px-3 py-2 text-sm',
        TONE[tone],
        className,
      )}
    >
      <span aria-hidden className="font-bold">
        {ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A transient message with a dismiss button. The live region is always in the DOM (empty when there
 * is no message) so assistive tech reliably announces the text when it appears.
 */
export function Toast({
  message,
  onDismiss,
  tone = 'info',
  className,
}: {
  message: string;
  onDismiss: () => void;
  tone?: AlertTone;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={className}>
      {message && (
        <Alert tone={tone}>
          <span className="flex items-start justify-between gap-2">
            <span>{message}</span>
            <button type="button" className="font-semibold underline" onClick={onDismiss}>
              Dismiss
            </button>
          </span>
        </Alert>
      )}
    </div>
  );
}
