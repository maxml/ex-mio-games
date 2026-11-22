import { Button } from './Button';
import { Stepper, type Step } from './Stepper';

export interface SetupChecklistProps {
  /** `done` must be true only for steps the server (or the mock) says are finished. */
  steps: Step[];
  /** Id of the open step. */
  current: string;
  onSelect: (stepId: string) => void;
  /** `progress` (default): the stepper and a "2 of 6 done" line. `missing`: the open steps as a list. */
  variant?: 'progress' | 'missing';
}

/** Setup progress. Wraps the Stepper, so `nav[aria-label=Progress]` and its "(complete)" text stay. */
export function SetupChecklist({
  steps,
  current,
  onSelect,
  variant = 'progress',
}: SetupChecklistProps) {
  const doneCount = steps.filter((s) => s.done).length;
  if (variant === 'missing') {
    const missing = steps.filter((s) => !s.done);
    return (
      <div>
        <p className="text-sm font-semibold">Still missing</p>
        {missing.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing is missing.</p>
        ) : (
          <ul className="mt-1 grid gap-1">
            {missing.map((s) => (
              <li key={s.id}>
                <Button size="sm" variant="ghost" onClick={() => onSelect(s.id)}>
                  {s.label}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div>
      <p className="mb-2 text-sm font-semibold" role="status">
        {doneCount} of {steps.length} done
      </p>
      <Stepper
        steps={steps}
        current={Math.max(
          0,
          steps.findIndex((s) => s.id === current),
        )}
        onSelect={(i) => onSelect(steps[i]!.id)}
      />
    </div>
  );
}
