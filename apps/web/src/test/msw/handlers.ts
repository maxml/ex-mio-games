import { http, HttpResponse } from 'msw';
import type { HealthCheck } from '@ex-mio/contracts';

// Shared MSW request handlers for the web test suite (ADR-0013 §8). Shapes mirror
// the API contract from `@ex-mio/contracts`, so the mocks stay in lockstep with
// the envelopes the typed `http` client validates against.
//
// Host-agnostic patterns (`*/path`) match regardless of `NEXT_PUBLIC_API_URL`.

/** Healthy `GET /healthz/ready` body matching the shared `HealthCheck` schema. */
export const seedHealth: HealthCheck = {
  status: 'ok',
  uptime: 1234,
  version: '0.0.1',
  checks: {
    db: { status: 'ok', latencyMs: 2 },
  },
};

export const handlers = [http.get('*/healthz/ready', () => HttpResponse.json(seedHealth))];
