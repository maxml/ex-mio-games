import { createBff, createMemorySessionStore, readBffConfig } from '@/layers/shared/api/bff';

// The web BFF (D-10): the browser's only door to the services. One HttpOnly session cookie, tokens kept in the
// server-side session, every service call validated against `packages/contracts`. See
// `src/layers/shared/api/bff/handlers.ts` for the route table and docs/submission/known-gaps.md for the
// calls that still have no service endpoint.
export const dynamic = 'force-dynamic';

// One store per server process (module scope survives across requests in the standalone `node server.js`).
const sessions = createMemorySessionStore();

const handle = (request: Request) =>
  createBff({ config: readBffConfig(), sessions }).handle(request);

export const GET = handle;
export const POST = handle;
