import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Unique per tab set; ties each tab to its panel (see TabPanel). */
  idPrefix: string;
  className?: string;
}

/** WAI-ARIA tabs with a roving tabindex: arrows, Home and End select the tab AND move focus to it. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, className }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === value);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className={cn('flex gap-1 rounded-md bg-surface-2 p-1', className)} onKeyDown={onKeyDown}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={cn('flex-1 rounded-sm px-2 py-2 text-sm font-semibold', value === t.id ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`}>
      {children}
    </div>
  );
}
