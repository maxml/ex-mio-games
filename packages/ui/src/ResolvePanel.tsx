import { useState, type FormEvent } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Field, Input } from './Input';
import { PreviewNotice } from './Notices';

/** Matches the engagement `ResolveReviewRequest`: outcome plus a reason of 3 to 500 characters. */
export interface ResolveReviewPayload {
  outcome: 'issued' | 'not_issued';
  reason: string;
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export interface ResolvePanelProps {
  /** Which redemption is being resolved (shown in the title). */
  redemptionLabel: string;
  onResolve: (payload: ResolveReviewPayload) => void;
  onCancel?: () => void;
  busy?: boolean;
  /** The resolve route has no BFF passthrough yet: show the preview notice. */
  preview?: boolean;
}

/** Operator resolves a redemption that needs review: outcome, a reason, Submit. */
export function ResolvePanel({
  redemptionLabel,
  onResolve,
  onCancel,
  busy,
  preview,
}: ResolvePanelProps) {
  const [outcome, setOutcome] = useState<ResolveReviewPayload['outcome']>('issued');
  const [reason, setReason] = useState('');
  const len = reason.trim().length;
  const valid = len >= REASON_MIN && len <= REASON_MAX;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid && !busy) onResolve({ outcome, reason: reason.trim() });
  }
  return (
    <Card title={`Resolve ${redemptionLabel}`} description="Pick the outcome and say why.">
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        {preview && <PreviewNotice />}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold">Outcome</legend>
          {(
            [
              ['issued', 'Issued'],
              ['not_issued', 'Not issued'],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="resolve-outcome"
                className="size-4 accent-primary"
                checked={outcome === value}
                onChange={() => setOutcome(value)}
              />
              {text}
            </label>
          ))}
        </fieldset>
        <Field
          label="Reason"
          hint={`${REASON_MIN} to ${REASON_MAX} characters.`}
          error={
            len > 0 && !valid
              ? `The reason needs ${REASON_MIN} to ${REASON_MAX} characters.`
              : undefined
          }
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              value={reason}
              maxLength={REASON_MAX}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!valid} loading={busy}>
            Submit
          </Button>
          {onCancel && (
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
