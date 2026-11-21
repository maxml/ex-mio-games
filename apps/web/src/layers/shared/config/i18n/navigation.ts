import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// Locale-aware navigation primitives bound to the routing config above. Prefer
// these over `next/link` / `next/navigation` so the active locale prefix is
// preserved automatically. Re-exported through `shared/config` (the segment's
// Public API).
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
