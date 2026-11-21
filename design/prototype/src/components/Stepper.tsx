import { cn } from './cn';

export interface Step {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: Step[];
  /** Index of the current step; earlier ones are complete. */
  current: number;
  onSelect?: (index: number) => void;
  className?: string;
}

/** Numbered progress list. State is conveyed by text and marker, not colour alone. */
export function Stepper({ steps, current, onSelect, className }: StepperProps) {
  return (
    <nav aria-label="Progress" className={className}>
      <ol className="flex flex-wrap gap-x-2 gap-y-2">
        {steps.map((s, i) => {
          const done = i < current;
          const active = i === current;
          const body = (
            <>
              <span
                aria-hidden
                className={cn(
                  'inline-flex size-6 items-center justify-center rounded-full border text-xs font-bold',
                  done && 'border-success bg-surface text-success',
                  active && 'border-primary bg-primary text-primary-fg',
                  !done && !active && 'border-border text-fg-muted',
                )}
              >
                {done ? '✓' : i + 1}
              </span>
              <span className={cn('text-sm', active ? 'font-semibold text-fg' : 'text-fg-muted')}>{s.label}</span>
              <span className="sr-only">{done ? '(complete)' : active ? '(current step)' : '(not started)'}</span>
            </>
          );
          return (
            <li key={s.id} className="flex items-center">
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  aria-current={active ? 'step' : undefined}
                  className="inline-flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2"
                >
                  {body}
                </button>
              ) : (
                <span aria-current={active ? 'step' : undefined} className="inline-flex items-center gap-2 px-2 py-1">
                  {body}
                </span>
              )}
              {i < steps.length - 1 && <span aria-hidden className="ml-2 h-px w-4 bg-border" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
