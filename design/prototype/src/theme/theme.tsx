import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import luckyStar from './tenants/lucky-star.json';
import northbet from './tenants/northbet.json';

export interface TenantTheme {
  id: string;
  name: string;
  description?: string;
  tokens: Record<string, string>;
}

/** The neutral MIO placeholder theme: no overrides, everything comes from tokens.css. */
export const MIO_DEFAULT: TenantTheme = {
  id: 'mio',
  name: 'MIO default',
  description: 'Neutral placeholder until brand materials exist.',
  tokens: {},
};

export const THEMES: TenantTheme[] = [MIO_DEFAULT, luckyStar, northbet];

/**
 * Turns a tenant theme into inline CSS variables. This is the whole theming runtime:
 * the server (or the embed script) does the same thing on the widget root.
 */
export function themeStyle(theme: TenantTheme): CSSProperties {
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.tokens)) style[`--${k}`] = v;
  return style as CSSProperties;
}

interface ThemeCtx {
  theme: TenantTheme;
  setThemeId: (id: string) => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string>(() => {
    try {
      return localStorage.getItem('mio-proto-theme') ?? 'mio';
    } catch {
      return 'mio';
    }
  });
  const theme = THEMES.find((t) => t.id === id) ?? MIO_DEFAULT;

  // Apply to <html> so page background and portals follow the theme too.
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.tenant = theme.id;
    for (const t of THEMES)
      for (const k of Object.keys(t.tokens)) el.style.removeProperty(`--${k}`);
    for (const [k, v] of Object.entries(theme.tokens)) el.style.setProperty(`--${k}`, v);
    try {
      localStorage.setItem('mio-proto-theme', theme.id);
    } catch {
      /* storage blocked: theme still applies for this session */
    }
  }, [theme]);

  return <Ctx.Provider value={{ theme, setThemeId: setId }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
