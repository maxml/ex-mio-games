// Reference endpoint that demonstrates the typed `http` client + schema
// validation (ADR-0013 §7). Richer per-entity calls belong in
// `entities/<entity>/api` once those slices exist.
import { HealthCheck } from '../types';
import { http } from './http';

/** GET `/healthz/ready`, validated against the shared `HealthCheck` schema. */
export function getHealth(): Promise<HealthCheck> {
  return http.get<HealthCheck>('/healthz/ready', { schema: HealthCheck });
}
