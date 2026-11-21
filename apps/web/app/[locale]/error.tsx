'use client';

import { useEffect } from 'react';
import { Alert, Button, Heading } from '@/layers/shared/ui';
import { reportError } from '../../lib/error-reporter';

// Route-level error boundary for the `[locale]` segment: catches render/data
// errors inside the layout. `global-error.tsx` only fires for errors in the root
// layout itself, so both are needed.
export default function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    reportError(error, { boundary: 'route' });
  }, [error]);

  return (
    <main className="mx-auto flex max-w-screen-md flex-col gap-3 px-4 py-6">
      <Heading level={1}>Something went wrong</Heading>
      <Alert tone="danger">{error.message}</Alert>
      <Button variant="secondary" className="self-start" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
