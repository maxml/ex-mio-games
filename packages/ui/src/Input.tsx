import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cn } from './cn';

// One field look for every form control. The border uses `input-border` (3:1 on the surface),
// not the decorative `border` token.
const BASE = 'rounded-md border bg-surface text-sm text-fg';
const SIZE = { md: 'h-10 w-full px-3', sm: 'h-9 px-2' } as const;

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** `sm` is for cells inside tables; give it a width with className. */
  size?: keyof typeof SIZE;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid, className, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(BASE, SIZE[size], invalid ? 'border-danger' : 'border-input-border', className)}
      {...rest}
    />
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: keyof typeof SIZE;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', className, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        BASE,
        'border-input-border',
        size === 'md' ? 'h-10 px-3' : 'h-9 px-2',
        className,
      )}
      {...rest}
    />
  );
});

/** Label + control + hint/error, wired with matching ids. The control is a render prop to receive them. */
export function Field({
  label,
  hint,
  error,
  hideLabel,
  children,
}: {
  label: string;
  /** Visually hide the label (it stays for screen readers), for a field inside a table cell. */
  hideLabel?: boolean;
  hint?: string;
  error?: string;
  children: (props: { id: string; invalid: boolean; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  const text = error ?? hint;
  return (
    <div>
      <label
        htmlFor={id}
        className={cn('mb-1 block text-sm font-semibold', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      {children({ id, invalid: Boolean(error), describedBy: text ? msgId : undefined })}
      {text && (
        <p
          id={msgId}
          role={error ? 'alert' : undefined}
          className={cn('mt-1 text-xs', error ? 'text-danger' : 'text-fg-muted')}
        >
          {text}
        </p>
      )}
    </div>
  );
}
