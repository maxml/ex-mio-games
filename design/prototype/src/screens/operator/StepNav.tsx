import { Button } from '../../components';
import { STEPS } from '../../state/reducer';
import { appStore } from '../../state/store';

/**
 * Back / Continue for one wizard step. Continue marks the step complete and moves on; when the step
 * has unmet work it stays disabled and says what is missing instead of being a silent dead end.
 */
export function StepNav({ index, canContinue = true, hint, nextLabel }: { index: number; canContinue?: boolean; hint?: string; nextLabel?: string }) {
  const last = index === STEPS.length - 1;
  const hintId = `stepnav-hint-${index}`;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button variant="secondary" disabled={index === 0} onClick={() => appStore.dispatch({ type: 'step/set', step: index - 1 })}>
        Back
      </Button>
      <Button
        disabled={!canContinue}
        aria-describedby={!canContinue && hint ? hintId : undefined}
        onClick={() => {
          appStore.dispatch({ type: 'step/complete', id: STEPS[index].id });
          if (!last) appStore.dispatch({ type: 'step/set', step: index + 1 });
        }}
      >
        {nextLabel ?? (last ? 'Finish setup' : `Continue to ${STEPS[index + 1].label.toLowerCase()}`)}
      </Button>
      {!canContinue && hint && <p id={hintId} className="text-sm text-fg-muted">{hint}</p>}
    </div>
  );
}
