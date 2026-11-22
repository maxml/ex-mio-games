'use client';

import { Alert, Card, Text, ThemeProvider } from '@/layers/shared/ui';
import { useLaunch } from '../model/use-launch';
import { useWidgetOpened } from '../model/use-widget-opened';
import { PlayerWidgetView } from './PlayerWidgetView';

/** Route body of the embeddable widget: tenant theme on the root, the widget in a narrow column. */
export function EmbeddedPlayerWidget({
  themeId,
  launchToken,
}: {
  themeId?: string;
  launchToken?: string;
}) {
  useWidgetOpened(launchToken);
  const launch = useLaunch(launchToken);
  return (
    <ThemeProvider initialId={themeId ?? 'mio'}>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-xl p-2 outline-none">
        {launch === 'launching' ? (
          <Card aria-label="MIO Games widget" title="Daily Wheel">
            <Text role="status" tone="muted">
              Signing you in...
            </Text>
          </Card>
        ) : (
          <>
            {launch === 'rejected' && (
              <Alert tone="warning" className="mb-2">
                <span role="status">
                  The casino link was not accepted (it may have expired or been used already). Open
                  the widget again from your casino.
                </span>
              </Alert>
            )}
            <PlayerWidgetView />
          </>
        )}
      </main>
    </ThemeProvider>
  );
}
