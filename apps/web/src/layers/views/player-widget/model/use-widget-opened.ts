'use client';

import { useEffect, useRef } from 'react';

/**
 * Product analytics: tell the BFF the widget was opened, once per mount (the funnel's first step,
 * `web.widget_opened`). The BFF keeps the anonymous id in its own session cookie, so nothing is
 * stored here. A re-render, or React strict mode's second effect run, sends nothing more.
 * `launchToken` is only the unverified hint the BFF reads the tenant from before a launch.
 * Fire and forget: analytics never blocks or breaks the widget.
 */
export function useWidgetOpened(launchToken?: string): void {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void fetch('/api/widget/opened', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(launchToken ? { token: launchToken } : {}),
    }).catch(() => undefined);
  }, [launchToken]);
}
