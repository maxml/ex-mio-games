import type { ReactNode } from 'react';
import { Select } from './Input';
import { cn } from './cn';
import { THEMES, useTheme } from './theme/theme';

/** Page template: centred column with a title and an intro. */
export function Page({
  title,
  intro,
  children,
  className,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto max-w-5xl px-4 py-6', className)}>
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      {intro && <p className="mb-4 text-sm text-fg-muted">{intro}</p>}
      {children}
    </div>
  );
}

/** First focusable element: jumps to the page's `<main>` without touching the URL. */
export function SkipLink({ targetId = 'main' }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      onClick={(e) => {
        e.preventDefault();
        const main = document.getElementById(targetId);
        main?.focus();
        main?.scrollIntoView?.();
      }}
      className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:bg-surface focus:p-2"
    >
      Skip to content
    </a>
  );
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
}

/** Top bar with the section links; `current` is marked for assistive tech and by more than colour. */
export function SiteHeader({
  items,
  current,
  label = 'Sections',
  children,
}: {
  items: NavItem[];
  current: string;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface">
      <div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
        <nav aria-label={label} className="flex gap-1">
          {items.map((r) => (
            <a
              key={r.id}
              href={r.href}
              aria-current={r.id === current ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-semibold',
                r.id === current ? 'bg-primary text-primary-fg' : 'text-fg hover:bg-surface-2',
              )}
            >
              {r.label}
            </a>
          ))}
        </nav>
        {children}
      </div>
    </header>
  );
}

/** Switches the tenant theme (preview tool for staff and Storybook; players never see it). */
export function ThemeSwitcher() {
  const { theme, setThemeId } = useTheme();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-fg-muted">Tenant theme</span>
      <Select size="sm" value={theme.id} onChange={(e) => setThemeId(e.target.value)}>
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
