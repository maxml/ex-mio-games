import { Badge } from './StatusPill';
import { cn } from './cn';

export interface PlanCardProps {
  name: string;
  /** EUR per month. */
  price: number;
  spins: string;
  extra: string;
  selected: boolean;
  /** Radio group name; all cards of one group share it. */
  group?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** One selectable plan. A native radio (visually hidden) keeps arrow-key behaviour and the focus ring. */
export function PlanCard({
  name,
  price,
  spins,
  extra,
  selected,
  group = 'plan',
  disabled,
  onSelect,
}: PlanCardProps) {
  return (
    <label
      className={cn(
        'cursor-pointer rounded-lg border p-4',
        'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        selected ? 'border-primary bg-surface-2' : 'border-input-border bg-surface',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name={group}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="flex items-center justify-between">
        <span className="font-display text-base font-semibold">{name}</span>
        {selected && (
          <Badge tone="primary" icon>
            Selected
          </Badge>
        )}
      </span>
      <span className="mt-2 block font-display text-2xl font-bold">
        {price} EUR<span className="text-sm font-normal text-fg-muted"> / month</span>
      </span>
      <span className="mt-2 block text-sm">{spins}</span>
      <span className="block text-sm text-fg-muted">{extra}</span>
    </label>
  );
}
