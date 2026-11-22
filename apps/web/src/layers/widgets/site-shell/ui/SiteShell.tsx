'use client';

import { useLocale } from 'next-intl';
import type { ReactNode } from 'react';
import { usePathname } from '@/layers/shared/config';
import { SiteHeader, SkipLink, ThemeProvider, ThemeSwitcher } from '@/layers/shared/ui';

const SECTIONS = [
  { id: 'home', label: 'Home', path: '' },
  { id: 'operator', label: 'Operator console', path: '/operator' },
  { id: 'admin', label: 'Platform admin', path: '/admin' },
  { id: 'widget', label: 'Player widget', path: '/embed/widget' },
] as const;

/** Chrome of the staff and demo screens: skip link, section links, tenant-theme preview, `<main>`. */
export function SiteShell({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const pathname = usePathname(); // locale prefix already removed
  const current = SECTIONS.find((s) => s.path !== '' && pathname.startsWith(s.path))?.id ?? 'home';
  return (
    <ThemeProvider>
      <SkipLink />
      <SiteHeader
        label="Screens"
        current={current}
        items={SECTIONS.map((s) => ({ id: s.id, label: s.label, href: `/${locale}${s.path}` }))}
      >
        <ThemeSwitcher />
      </SiteHeader>
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </ThemeProvider>
  );
}
