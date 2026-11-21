import { setupServer } from 'msw/node';
import { handlers } from './handlers';

// Node MSW server for the Vitest suite. `setupServer` patches the global
// fetch/undici stack so the typed `http` client (`shared/api/http`) talks to the
// shared handlers above instead of the network. Lifecycle (listen/reset/close)
// is wired in `../setup.ts`.
export const server = setupServer(...handlers);
