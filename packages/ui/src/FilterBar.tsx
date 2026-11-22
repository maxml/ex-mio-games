import { Button } from './Button';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterBarProps<T extends string> {
  options: FilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
}

/** A row of toggle buttons that filters a list by one value; the active one has `aria-pressed`. */
export function FilterBar<T extends string>({
  options,
  value,
  onChange,
  label = 'Filter by status',
}: FilterBarProps<T>) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={o.value === value ? 'primary' : 'secondary'}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
