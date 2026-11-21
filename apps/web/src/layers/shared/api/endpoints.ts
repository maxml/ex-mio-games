// Reference endpoints that demonstrate the typed `http` client + schema
// validation (ADR-0005 §7). Kept minimal and domain-light; richer per-entity calls
// belong in `entities/<entity>/api` once those slices exist.
import { HealthCheck, User, type CreateUserInput } from '../types';
import { http } from './http';

/** GET `/healthz`, validated against the shared `HealthCheck` schema. */
export function getHealth(): Promise<HealthCheck> {
  return http.get<HealthCheck>('/healthz', { schema: HealthCheck });
}

/**
 * GET `/api/users`. The baseline API wraps the rows in a `{ users }` envelope,
 * so unwrap it and validate each row against the shared `User` schema.
 */
export async function listUsers(): Promise<User[]> {
  const { users } = await http.get<{ users: User[] }>('/api/users');
  return User.array().parse(users);
}

/**
 * POST `/api/users` — the reference write used by the `user-create` feature.
 * Body is the shared `CreateUserInput`; the 201 response is validated as `User`.
 * Rejects with `HttpError` on 400 (validation `issues`) / 409 (duplicate email).
 */
export function createUser(input: CreateUserInput): Promise<User> {
  return http.post<User>('/api/users', input, { schema: User });
}
