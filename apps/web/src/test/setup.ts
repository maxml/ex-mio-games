import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { server } from './msw/server';

// Global Vitest setup (referenced by vitest.config.ts `setupFiles`):
//   - extend `expect` with @testing-library/jest-dom matchers;
//   - run the MSW node server for the whole suite, asserting on any request that
//     no handler covers (`onUnhandledRequest: 'error'`) so missed mocks surface;
//   - reset handlers + unmount React trees between tests for isolation.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
