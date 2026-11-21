import type { ReactNode } from 'react';
import { SiteShell } from '@/layers/widgets/site-shell';

// Staff and demo screens share this chrome; the embeddable widget (`(embed)`) has none.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
