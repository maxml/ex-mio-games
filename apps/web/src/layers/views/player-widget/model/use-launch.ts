'use client';

import { useEffect, useRef, useState } from 'react';

export type LaunchState = 'ready' | 'launching' | 'rejected';

// One launch per token, even when React strict mode runs the effect twice: a launch token is single-use,
// so a second exchange would be refused and would look like a failure.
const launches = new Map<string, Promise<boolean>>();

/**
 * Exchanges the casino's launch token (`?token=` of the embed URL) for the widget session: the BFF
 * verifies it with identity and sets the HttpOnly session cookie. Without a token there is nothing to
 * exchange (mock mode, or a session that already exists), so the widget is `ready` at once. While the
 * exchange runs the widget must not read the player state: it would be refused with 401.
 * `rejected` means identity refused the token (expired, already used, wrong key): the widget still
 * renders and shows its own error if no session exists.
 */
export function useLaunch(launchToken?: string): LaunchState {
  const [state, setState] = useState<LaunchState>(launchToken ? 'launching' : 'ready');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!launchToken) return;
    let pending = launches.get(launchToken);
    if (!pending) {
      pending = fetch('/api/session/launch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: launchToken }),
      }).then(
        (r) => r.ok,
        () => false,
      );
      launches.set(launchToken, pending);
    }
    void pending.then((ok) => {
      if (mounted.current) setState(ok ? 'ready' : 'rejected');
    });
  }, [launchToken]);
  return state;
}
