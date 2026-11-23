import type { HTMLAttributes } from 'react';
import { cn } from './cn';
import { themeStyle, useTheme, type TenantTheme } from './theme/theme';

export interface MainProps extends HTMLAttributes<HTMLElement> {
  /** A narrow centred column, for an embeddable widget. */
  narrow?: boolean;
  /** Apply a tenant theme to the landmark (the player sees the operator's look). */
  theme?: TenantTheme;
}

/**
 * The page's `<main>` landmark. It is the target of the skip link, so it is focusable by script
 * (`tabIndex -1`, id `main` unless given) and shows no focus ring when it receives that focus.
 */
export function Main({ narrow, theme, className, style, ...rest }: MainProps) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className={cn(narrow && 'mx-auto w-full max-w-xl p-2', 'outline-none', className)}
      style={theme ? { ...themeStyle(theme), ...style } : style}
      {...rest}
    />
  );
}

/** Applies the current tenant theme's tokens to everything inside. */
export function ThemeScope({ className, style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { theme } = useTheme();
  return (
    <div
      style={{ ...themeStyle(theme), ...style }}
      className={cn('text-fg', className)}
      {...rest}
    />
  );
}

/**
 * A polite live region that is always in the DOM, so assistive tech announces text put into it later.
 * It is visually hidden by default (the same words are usually shown elsewhere); `visible` shows it.
 */
export function LiveRegion({
  visible,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { visible?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(!visible && 'sr-only', className)}
      {...rest}
    />
  );
}

/** A signed coin amount: positive in the success colour, negative muted, zero as plain text. */
export function SignedAmount({ value, zero = 'spins' }: { value: number; zero?: string }) {
  return (
    <span
      className={cn(
        'font-semibold tabular-nums',
        value > 0 && 'text-success',
        value < 0 && 'text-fg-muted',
      )}
    >
      {value > 0 ? `+${value}` : value < 0 ? `${value}` : zero}
    </span>
  );
}
