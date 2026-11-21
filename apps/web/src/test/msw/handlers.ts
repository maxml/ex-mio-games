import { http, HttpResponse } from 'msw';
import type { CreateUserInput, HealthCheck, User } from '@ex-mio/shared-types';

// Shared MSW request handlers for the web test suite (ADR-0005 §8). Shapes mirror the
// baseline API contract from `@ex-mio/shared-types`, so the mocks stay
// in lockstep with the real envelopes the typed `http` client validates against.
//
// Host-agnostic patterns (`*/path`) match regardless of `NEXT_PUBLIC_API_URL`.
// Exported so other suites can compose/override them — e.g. the WS client task
// (R3) will add WebSocket mocks alongside these.

/** Seed users returned by `GET /api/users`. */
export const seedUsers: User[] = [
  {
    id: 'u1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  },
];

/** Healthy `GET /healthz` body matching the shared `HealthCheck` schema. */
export const seedHealth: HealthCheck = {
  status: 'ok',
  uptime: 1234,
  version: '0.0.1',
  checks: {
    database: { status: 'ok', latencyMs: 2 },
  },
};

export const handlers = [
  http.get('*/healthz', () => HttpResponse.json(seedHealth)),

  http.get('*/api/users', () => HttpResponse.json({ users: seedUsers })),

  // Reference write used by the `user-create` feature. Mirrors the API's 400
  // validation envelope (Zod `issues`) so the form's field-mapping path is
  // exercised end to end.
  http.post('*/api/users', async ({ request }) => {
    const body = (await request.json()) as Partial<CreateUserInput> | null;
    const email = body?.email;
    if (typeof email !== 'string' || !email.includes('@')) {
      return HttpResponse.json(
        {
          message: 'Validation failed',
          code: 'validation_error',
          issues: [{ path: ['email'], message: 'Invalid email address' }],
        },
        { status: 400 },
      );
    }
    const created: User = {
      id: 'u-new',
      email,
      name: body?.name ?? null,
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
    };
    return HttpResponse.json(created, { status: 201 });
  }),
];
