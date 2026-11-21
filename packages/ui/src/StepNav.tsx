import { Button } from './Button';

export interface StepNavProps {
  index: number;
  /** Used for the id that ties the hint to the disabled button. */
  nextLabel: string;
  canContinue?: boolean;
  /** What is missing; shown (and announced as the button's description) while Continue is disabled. */
  hint?: string;
  onBack: () => void;
  onNext: () => void;
}

/** Back / Continue for one wizard step. A disabled Continue always says why. */
export function StepNav({
  index,
  nextLabel,
  canContinue = true,
  hint,
  onBack,
  onNext,
}: StepNavProps) {
  const hintId = `stepnav-hint-${index}`;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button variant="secondary" disabled={index === 0} onClick={onBack}>
        Back
      </Button>
      <Button
        disabled={!canContinue}
        aria-describedby={!canContinue && hint ? hintId : undefined}
        onClick={onNext}
      >
        {nextLabel}
      </Button>
      {!canContinue && hint && (
        <p id={hintId} className="text-sm text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
