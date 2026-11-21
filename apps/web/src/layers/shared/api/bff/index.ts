// Server-only: the web BFF behind `app/api/[...path]/route.ts`. Never import this from client code.
export { readBffConfig, type BffConfig } from './config';
export { createBff, type BffDeps } from './handlers';
export { createMemorySessionStore, SESSION_COOKIE, type SessionStore } from './session';
