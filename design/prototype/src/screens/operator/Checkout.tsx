import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input } from '../../components';

/** Test card that the fake provider declines, so the failure path can be shown. */
const DECLINED = '4000000000000002';

/**
 * Mock checkout for the `fake` payment provider (test mode). Nothing leaves the browser; the card
 * form shows where a real provider's hosted fields (Stripe) will sit.
 */
export function Checkout({
  amount,
  description,
  onPaid,
  onCancel,
}: {
  amount: number;
  description: string;
  onPaid: (last4: string) => void;
  onCancel?: () => void;
}) {
  const [number, setNumber] = useState('4242 4242 4242 4242');
  const [expiry, setExpiry] = useState('12 / 30');
  const [cvc, setCvc] = useState('123');
  const [holder, setHolder] = useState('Cherry Row Ltd');
  const [state, setState] = useState<'idle' | 'processing'>('idle');
  const [error, setError] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (state === 'processing') return;
    const digits = number.replace(/\D/g, '');
    if (digits.length !== 16) return setError('Enter a 16-digit card number. The test card is 4242 4242 4242 4242.');
    if (!/^\d{2}\s*\/\s*\d{2}$/.test(expiry)) return setError('Enter the expiry as MM / YY.');
    if (!/^\d{3,4}$/.test(cvc)) return setError('Enter the 3 or 4 digit security code.');
    setError('');
    setState('processing');
    window.setTimeout(() => {
      if (digits === DECLINED) {
        setState('idle');
        setError('The card was declined by the test provider. Use 4242 4242 4242 4242 instead.');
      } else onPaid(digits.slice(-4));
    }, 1100);
  }

  return (
    <Card title="Payment" description={description} actions={<span className="font-display text-xl font-bold tabular-nums">{amount.toFixed(2)} EUR</span>}>
      <Alert tone="warning" className="mb-4">
        <strong>Test mode.</strong> This is the fake payment provider: no real card is charged and no real money moves. Use 4242 4242 4242 4242; 4000 0000 0000 0002 is declined.
      </Alert>
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        <Field label="Name on card">{({ id }) => <Input id={id} value={holder} onChange={(e) => setHolder(e.target.value)} autoComplete="cc-name" />}</Field>
        <Field label="Card number">{({ id }) => <Input id={id} inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} autoComplete="cc-number" />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Expiry (MM / YY)">{({ id }) => <Input id={id} value={expiry} onChange={(e) => setExpiry(e.target.value)} autoComplete="cc-exp" />}</Field>
          <Field label="Security code">{({ id }) => <Input id={id} inputMode="numeric" value={cvc} onChange={(e) => setCvc(e.target.value)} autoComplete="cc-csc" />}</Field>
        </div>
        <div role="alert" className="min-h-5 text-sm text-danger">{error}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={state === 'processing'}>
            {state === 'processing' ? 'Processing with test provider' : `Pay ${amount.toFixed(2)} EUR`}
          </Button>
          {onCancel && <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  );
}
