import { Checkbox } from './Checkbox';
import { Field, Input } from './Input';

export interface RuleValues {
  min: number;
  spins: number;
  per: boolean;
  cap: number;
}

export interface RuleEditorProps {
  value: RuleValues;
  onChange: (next: RuleValues) => void;
  /** Result text shown under the form; the caller computes it from the same rules the server applies. */
  preview: string;
}

const num = (v: string) => (v === '' ? NaN : Number(v));
const show = (n: number) => (Number.isNaN(n) ? '' : n);

/** Spin rules form: when does a deposit earn spins. NaN means "field emptied"; the caller validates. */
export function RuleEditor({ value, onChange, preview }: RuleEditorProps) {
  const set = (p: Partial<RuleValues>) => onChange({ ...value, ...p });
  return (
    <div>
      <div className="grid max-w-md gap-4">
        <Field label="Minimum deposit (EUR)">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={show(value.min)}
              onChange={(e) => set({ min: num(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Spins granted">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={show(value.spins)}
              onChange={(e) => set({ spins: num(e.target.value) })}
            />
          )}
        </Field>
        <Checkbox
          label="Repeat for every full multiple of the minimum"
          checked={value.per}
          onChange={(e) => set({ per: e.target.checked })}
        />
        <Field label="Daily spin cap per player">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={show(value.cap)}
              onChange={(e) => set({ cap: num(e.target.value) })}
            />
          )}
        </Field>
      </div>
      <p className="mt-4 rounded-md bg-surface-2 p-3 text-sm" role="status">
        {preview}
      </p>
    </div>
  );
}
