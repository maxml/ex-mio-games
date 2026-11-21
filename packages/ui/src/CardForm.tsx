import { useState, type FormEvent } from 'react';
import { Alert } from './Toast';
import { Button } from './Button';
import { Card } from './Card';
import { Field, Input } from './Input';

export interface CardFormProps {
  amount: number;
  description: string;
  /** A payment attempt is in flight: the button is busy and a second submit is ignored. */
  processing?: boolean;
  /** Provider-side failure to show under the form (a decline). */
  failure?: string;
  /** Shows the "no real money moves" banner of the fake provider. */
  testMode?: boolean;
  /** Called with the last four digits only; the full number leaves the form only through `onSubmitCard`. */
  onSubmit: (last4: string) => void;
  /**
   * Test mode only (W-9): the payments service takes the provider's test card number to run its fake
   * provider and keeps only last4 and brand. Called just before `onSubmit`; a real provider's hosted
   * fields never expose the number, so this prop goes away with the fake provider.
   */
  onSubmitCard?: (digits: string) => void;
  onCancel?: () => void;
}

/**
 * Card form for the checkout. With the `fake` provider this is the whole payment UI; a real provider
 * replaces the inputs with its hosted fields and keeps the same props.
 */
export function CardForm({
  amount,
  description,
  processing,
  failure,
  testMode,
  onSubmit,
  onSubmitCard,
  onCancel,
}: CardFormProps) {
  const [number, setNumber] = useState('4242 4242 4242 4242');
  const [expiry, setExpiry] = useState('12 / 30');
  const [cvc, setCvc] = useState('123');
  const [holder, setHolder] = useState('Cherry Row Ltd');
  const [error, setError] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (processing) return;
    const digits = number.replace(/\D/g, '');
    if (digits.length !== 16)
      return setError('Enter a 16-digit card number. The test card is 4242 4242 4242 4242.');
    if (!/^\d{2}\s*\/\s*\d{2}$/.test(expiry)) return setError('Enter the expiry as MM / YY.');
    if (!/^\d{3,4}$/.test(cvc)) return setError('Enter the 3 or 4 digit security code.');
    setError('');
    onSubmitCard?.(digits);
    onSubmit(digits.slice(-4));
  }

  return (
    <Card
      title="Payment"
      description={description}
      actions={
        <span className="font-display text-xl font-bold tabular-nums">{amount.toFixed(2)} EUR</span>
      }
    >
      {testMode && (
        <Alert tone="warning" className="mb-4">
          <strong>Test mode.</strong> This is the fake payment provider: no real card is charged and
          no real money moves. Use 4242 4242 4242 4242; 4000 0000 0000 0002 is declined.
        </Alert>
      )}
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        <Field label="Name on card">
          {({ id }) => (
            <Input
              id={id}
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
              autoComplete="cc-name"
            />
          )}
        </Field>
        <Field label="Card number">
          {({ id }) => (
            <Input
              id={id}
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              autoComplete="cc-number"
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Expiry (MM / YY)">
            {({ id }) => (
              <Input
                id={id}
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                autoComplete="cc-exp"
              />
            )}
          </Field>
          <Field label="Security code">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={cvc}
                onChange={(e) => setCvc(e.target.value)}
                autoComplete="cc-csc"
              />
            )}
          </Field>
        </div>
        <div role="alert" className="min-h-5 text-sm text-danger">
          {error || failure || ''}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={processing}>
            {processing ? 'Processing with test provider' : `Pay ${amount.toFixed(2)} EUR`}
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
