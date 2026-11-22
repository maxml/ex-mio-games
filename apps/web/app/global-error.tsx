'use client';

import { useEffect } from 'react';
import { Alert, Button, Heading } from '@/layers/shared/ui';
import { reportError } from '../lib/error-reporter';
import './globals.css';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    reportError(error, { boundary: 'global' });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg">
        <main className="mx-auto flex max-w-screen-md flex-col gap-3 p-6">
          <Heading level={1}>Something went wrong</Heading>
          <Alert tone="danger">{error.message}</Alert>
          <Button variant="secondary" className="self-start" onClick={reset}>
            Try again
          </Button>
        </main>
      </body>
    </html>
  );
}
