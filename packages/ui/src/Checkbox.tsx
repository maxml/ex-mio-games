import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  /** Visible label. Pass `hideLabel` for table cells where the column header already says it. */
  label: ReactNode;
  hideLabel?: boolean;
  /** Extra inline content after the label (a status pill, for example). */
  trailing?: ReactNode;
  /** Secondary colour, for an option that is not the main action (a demo switch). */
  muted?: boolean;
}

/** The one checkbox: native input (keyboard and screen readers for free) with a themed, 3:1 outline. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hideLabel, trailing, muted, className, ...rest },
  ref,
) {
  return (
    <label
      className={cn('inline-flex items-center gap-2 text-sm', muted && 'text-fg-muted', className)}
    >
      <input ref={ref} type="checkbox" className="size-4 shrink-0 accent-primary" {...rest} />
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
      {trailing}
    </label>
  );
});
