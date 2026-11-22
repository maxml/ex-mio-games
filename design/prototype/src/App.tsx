import { useEffect, useState } from 'react';
import { AdminScreen } from './screens/AdminConsole';
import { OperatorScreen } from './screens/OperatorConsole';
import { PlayerScreen } from './screens/PlayerWidget';
import { THEMES, useTheme } from './theme/theme';
import { Select, cn } from './components';

const ROUTES = [
  { id: 'player', label: 'Player widget', view: PlayerScreen },
  { id: 'operator', label: 'Operator console', view: OperatorScreen },
  { id: 'admin', label: 'Platform admin', view: AdminScreen },
] as const;

function useHashRoute(): string {
  const read = () => window.location.hash.replace('#/', '') || 'player';
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function App() {
  const route = useHashRoute();
  const { theme, setThemeId } = useTheme();
  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0];
  const View = current.view;
  return (
    <>
      {/* The router owns the URL hash, so a plain #main link would change the screen. Focus the
          current page's <main> instead and leave the hash alone. */}
      <a
        href={`#/${current.id}`}
        onClick={(e) => {
          e.preventDefault();
          const main = document.getElementById('main');
          main?.focus();
          main?.scrollIntoView?.();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:bg-surface focus:p-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 border-b border-border bg-surface">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
          <nav aria-label="Prototype screens" className="flex gap-1">
            {ROUTES.map((r) => (
              <a
                key={r.id}
                href={`#/${r.id}`}
                aria-current={r.id === current.id ? 'page' : undefined}
                className={cn('rounded-md px-3 py-2 text-sm font-semibold', r.id === current.id ? 'bg-primary text-primary-fg' : 'text-fg hover:bg-surface-2')}
              >
                {r.label}
              </a>
            ))}
          </nav>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Tenant theme</span>
            <Select size="sm" value={theme.id} onChange={(e) => setThemeId(e.target.value)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          </label>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="outline-none">
        <View />
      </main>
    </>
  );
}
