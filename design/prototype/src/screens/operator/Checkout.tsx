import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input } from '../../components';
import { cancelPayment, startPayment, useApp } from '../../state/store';

/**
 * Mock checkout for the `fake` payment provider (test mode). Nothing leaves the browser; the card
 * form shows where a real provider's hosted fields (Stripe) will sit. The attempt, its outcome
 * (paid or declined) and its cancellation all live in the store; this form only relays them.
 */
export function Checkout({
  plan,
  amount,
  description,
  onCancel,
}: {
  plan: string;
  /** Display only. The charged amount is taken from the price list in the store. */
  amount: number;
  description: string;
  onCancel?: () => void;
}) {
  const [number, setNumber] = useState('4242 4242 4242 4242');
  const [expiry, setExpiry] = useState('12 / 30');
  const [cvc, setCvc] = useState('123');
  const [holder, setHolder] = useState('Cherry Row Ltd');
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const payment = useApp((s) => s.operator.payment);
  const processing = payment?.status === 'processing';
  const declined = attempted && payment?.status === 'declined';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (processing) return;
    const digits = number.replace(/\D/g, '');
    if (digits.length !== 16) return setError('Enter a 16-digit card number. The test card is 4242 4242 4242 4242.');
    if (!/^\d{2}\s*\/\s*\d{2}$/.test(expiry)) return setError('Enter the expiry as MM / YY.');
    if (!/^\d{3,4}$/.test(cvc)) return setError('Enter the 3 or 4 digit security code.');
    setError('');
    setAttempted(true);
    startPayment(plan, digits.slice(-4));
  }

  function cancel() {
    if (payment?.status === 'processing') cancelPayment(payment.id);
    onCancel?.();
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
        <div role="alert" className="min-h-5 text-sm text-danger">
          {error || (declined ? 'The card was declined by the test provider. Use 4242 4242 4242 4242 instead.' : '')}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={processing}>
            {processing ? 'Processing with test provider' : `Pay ${amount.toFixed(2)} EUR`}
          </Button>
          {onCancel && <Button variant="secondary" onClick={cancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  );
}
