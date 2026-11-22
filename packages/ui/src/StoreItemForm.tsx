import { useState, type FormEvent } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Field, Input } from './Input';

/** A price is a whole number of coins above zero. */
export function priceError(price: number): string | undefined {
  return Number.isInteger(price) && price > 0
    ? undefined
    : 'Enter a whole number of coins above 0.';
}

export interface PriceFieldProps {
  label: string;
  /** NaN means the field is empty. */
  value: number;
  onChange: (price: number) => void;
  /** Show the error even before the first edit (a failed submit). */
  showError?: boolean;
  /** Compact input for table cells. */
  size?: 'sm' | 'md';
  /** Visually hide the label (a table column header says it). */
  hideLabel?: boolean;
}

/** Coin price input with its own `role=alert` error once edited. */
export function PriceField({
  label,
  value,
  onChange,
  showError,
  size = 'md',
  hideLabel,
}: PriceFieldProps) {
  const [dirty, setDirty] = useState(false);
  const error = dirty || showError ? priceError(value) : undefined;
  return (
    <Field label={label} error={error} hideLabel={hideLabel}>
      {({ id, invalid, describedBy }) => (
        <Input
          id={id}
          size={size}
          type="number"
          min={1}
          step={1}
          className={size === 'sm' ? 'w-28 text-right' : undefined}
          value={Number.isNaN(value) ? '' : value}
          invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => {
            setDirty(true);
            onChange(e.target.value === '' ? NaN : Number(e.target.value));
          }}
        />
      )}
    </Field>
  );
}

export interface StoreItemValues {
  name: string;
  priceCoins: number;
  bonusEur: number;
}

export interface StoreItemFormProps {
  onSubmit: (values: StoreItemValues) => void;
  busy?: boolean;
}

/** Add a bonus-store item: name, price in coins, bonus value in EUR. */
export function StoreItemForm({ onSubmit, busy }: StoreItemFormProps) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState<number>(NaN);
  const [bonus, setBonus] = useState<number>(0);
  const [tried, setTried] = useState(false);
  const nameError = name.trim() === '' ? 'Enter a name.' : undefined;
  const bonusError = bonus >= 0 ? undefined : 'The bonus value cannot be negative.';
  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || nameError || priceError(price) || bonusError) return;
    onSubmit({ name: name.trim(), priceCoins: price, bonusEur: bonus });
    setName('');
    setPrice(NaN);
    setBonus(0);
    setTried(false);
  }
  return (
    <Card title="Add an item">
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        <Field label="Name" error={tried ? nameError : undefined}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              value={name}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <PriceField label="Price (coins)" value={price} onChange={setPrice} showError={tried} />
        <Field label="Bonus value (EUR)" error={tried ? bonusError : undefined}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="number"
              min={0}
              value={Number.isNaN(bonus) ? '' : bonus}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => setBonus(e.target.value === '' ? 0 : Number(e.target.value))}
            />
          )}
        </Field>
        <div>
          <Button type="submit" loading={busy}>
            Add item
          </Button>
        </div>
      </form>
    </Card>
  );
}
