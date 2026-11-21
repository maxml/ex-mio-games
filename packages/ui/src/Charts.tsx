export interface BarChartProps {
  values: number[];
  /** Accessible description; the bars alone carry no text. */
  label: string;
}

/** Tiny column chart for a daily series. The numbers are in the accessible name. */
export function BarChart({ values, label }: BarChartProps) {
  const max = Math.max(1, ...values);
  return (
    <div
      className="flex h-32 items-end gap-1"
      role="img"
      aria-label={`${label}: ${values.join(', ')}`}
    >
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm bg-primary"
          style={{ height: `${(v / max) * 100}%` }}
        />
      ))}
    </div>
  );
}

export interface FunnelStep {
  step: string;
  value: number;
}

/** Ordered funnel: each row shows its value and its share of the previous step, as text and as a bar. */
export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const top = Math.max(1, steps[0]?.value ?? 1);
  return (
    <ol className="grid gap-3">
      {steps.map((f, i) => {
        const prev = steps[i - 1]?.value ?? 0;
        return (
          <li key={f.step}>
            <div className="flex justify-between text-sm">
              <span>{f.step}</span>
              <span className="tabular-nums">
                {f.value}
                {i > 0 && prev > 0 && (
                  <span className="text-fg-muted">
                    {' '}
                    ({((f.value / prev) * 100).toFixed(0)}% of previous)
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-3 rounded-sm bg-surface-2">
              <div
                className="h-3 rounded-sm bg-primary"
                style={{ width: `${(f.value / top) * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
