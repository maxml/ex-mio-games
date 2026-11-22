import { PlanCard } from './PlanCard';

export interface PlanOption {
  id: string;
  name: string;
  /** EUR per month. */
  price: number;
  spins: string;
  extra: string;
}

export interface PlanPickerProps {
  plans: PlanOption[];
  value: string | null;
  onChange: (planId: string) => void;
  disabled?: boolean;
  label?: string;
}

/** The plan radio group: one PlanCard per plan, arrow keys move the selection. */
export function PlanPicker({
  plans,
  value,
  onChange,
  disabled,
  label = 'Choose a plan',
}: PlanPickerProps) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-3 sm:grid-cols-3">
      {plans.map((p) => (
        <PlanCard
          key={p.id}
          name={p.name}
          price={p.price}
          spins={p.spins}
          extra={p.extra}
          selected={p.id === value}
          disabled={disabled}
          onSelect={() => onChange(p.id)}
        />
      ))}
    </div>
  );
}
