'use client';

import { ThemeProvider } from '@/layers/shared/ui';
import { PlayerWidgetView } from './PlayerWidgetView';

/** Route body of the embeddable widget: tenant theme on the root, the widget in a narrow column. */
export function EmbeddedPlayerWidget({ themeId }: { themeId?: string }) {
  return (
    <ThemeProvider initialId={themeId ?? 'mio'}>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-xl p-2 outline-none">
        <PlayerWidgetView />
      </main>
    </ThemeProvider>
  );
}
