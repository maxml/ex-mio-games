'use client';

import { useEffect } from 'react';
import { reportError } from '../lib/error-reporter';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    reportError(error, { boundary: 'global' });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100">
        <main className="mx-auto flex max-w-screen-md flex-col gap-3 p-6">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-neutral-400">{error.message}</p>
          <button
            onClick={reset}
            className="self-start rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
