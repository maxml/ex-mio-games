// Hash routing for the prototype, plus the role guard. `resolveRoute` is pure: given a hash path, the
// role and the live state it says which page to show or where to redirect. A route is one of:
//   #/operator                       -> redirect to the role's landing
//   #/operator/setup[/step]          -> Setup (also ?step=signup)
//   #/operator/engagement/{rules,wheel,store}, #/operator/operations/redemptions,
//   #/operator/insights, #/operator/team
//   #/admin (platform admin), #/player (player)
import { useEffect, useState } from 'react';
import {
  OPERATOR_PAGES,
  accessOf,
  landing,
  type PageAccess,
  type ProtoRole,
} from './config/operator-pages';

export interface Route {
  /** Path without the leading slash or the query, for example `operator/setup/keys`. */
  path: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', search = ''] = raw.split('?');
  return { path: path.replace(/\/+$/, ''), query: new URLSearchParams(search) };
}

export function useRoute(): Route {
  // The hash is read at render time, so a render that follows `navigate` already sees the new route
  // (the `hashchange` event arrives later). The state only asks React to render again.
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseHash(window.location.hash);
}

/** Go to a hash path (`/operator/setup/keys`). A redirect replaces the entry so Back does not loop. */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  const url = `#${to}`;
  if (opts?.replace) window.location.replace(url);
  else window.location.hash = url;
}

export type Resolved =
  | { kind: 'redirect'; to: string }
  | { kind: 'operator'; pageId: string; access: PageAccess; step?: string; denied?: string }
  | { kind: 'admin'; denied?: string }
  | { kind: 'player'; denied?: string };

const withDenied = (to: string, id: string) => `${to}${to.includes('?') ? '&' : '?'}denied=${id}`;

/** The guard. A role that may not open a surface goes to its own landing with `?denied=<page>`. */
export function resolveRoute(
  route: Route,
  role: ProtoRole,
  state?: { live?: 'off' | 'awaiting' | 'live' },
): Resolved {
  const home = landing(role, state);
  const denied = route.query.get('denied') ?? undefined;
  const [surface, ...rest] = route.path.split('/');
  if (surface === 'admin' && rest.length === 0) {
    return role === 'platform'
      ? { kind: 'admin', denied }
      : { kind: 'redirect', to: withDenied(home, 'admin') };
  }
  if (surface === 'player' && rest.length === 0) {
    return role === 'player'
      ? { kind: 'player', denied }
      : { kind: 'redirect', to: withDenied(home, 'player') };
  }
  if (surface === 'operator' && rest.length > 0) {
    const page = OPERATOR_PAGES.find((p) => {
      const base = p.href.replace(/^\//, '');
      return route.path === base || (p.id === 'setup' && route.path.startsWith(`${base}/`));
    });
    if (page) {
      const access = accessOf(role, page.id);
      if (access === 'none') return { kind: 'redirect', to: withDenied(home, page.id) };
      const step =
        page.id === 'setup'
          ? (route.path.split('/')[2] ?? route.query.get('step') ?? undefined)
          : undefined;
      return { kind: 'operator', pageId: page.id, access, step, denied };
    }
  }
  // `#/operator`, an empty hash or an unknown path: the role's landing.
  return { kind: 'redirect', to: home };
}
