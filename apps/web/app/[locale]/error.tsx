'use client';

import { useEffect } from 'react';
import { reportError } from '../../lib/error-reporter';

// Route-level error boundary for the `[locale]` segment: catches render/data
// errors inside the layout and keeps the chrome (header) around the fallback.
// `global-error.tsx` only fires for errors in the root layout itself, so both
// are needed.
export default function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    reportError(error, { boundary: 'route' });
  }, [error]);

  return (
    <main className="mx-auto flex max-w-screen-md flex-col gap-3 px-4 py-6">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-400">{error.message}</p>
      <button
        onClick={reset}
        className="self-start rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700"
      >
        Try again
      </button>
    </main>
  );
}
