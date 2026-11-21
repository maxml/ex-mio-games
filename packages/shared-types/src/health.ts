import { z } from 'zod';

export const HealthStatus = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const DependencyHealth = z.object({
  status: HealthStatus,
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyHealth = z.infer<typeof DependencyHealth>;

export const HealthCheck = z.object({
  status: HealthStatus,
  uptime: z.number().nonnegative(),
  version: z.string(),
  // Immutable commit id of the running build, surfaced when the deploy plane
  // (Deckhand) injects GIT_SHA. Optional so a project without the deploy plane
  // still validates.
  gitSha: z.string().optional(),
  checks: z.record(DependencyHealth),
});
export type HealthCheck = z.infer<typeof HealthCheck>;
