import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ReconciliationRun } from '@ex-mio/contracts';
import { buildApp } from '../testing/app';
import { bearer, T, tokens } from '../testing/auth';

// Choke point: the platform-admin read of the last reconciliation run (MIO-084 reader test, D-20),
// through the REAL application module (service-kit entry point, role guard, acting guard, exception
// filter) with the reconciliation service mocked. The record itself is written and read back through
// the database in services/ledger-jobs.service.pgtest.ts.

const RUN = {
  id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a30',
  status: 'mismatch',
  started_at: '2026-11-21T10:00:00.000Z',
  finished_at: '2026-11-21T10:00:02.000Z',
  accounts_checked: 14,
  mismatches: [
    {
      kind: 'balance_drift',
      account_id: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a31',
      reserve_id: null,
      transaction_id: null,
      expected: 10,
      actual: 11,
    },
  ],
  report: {
    issued: 10,
    available: 10,
    held: 0,
    captured: 0,
    released: 0,
    refunded: 0,
    holds: true,
  },
  stale: false,
} as const;

describe('GET /v1/platform/ledger/reconciliation', () => {
  const reconciliation = { last: jest.fn() };
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = (await buildApp({ reconciliation })).app;
  });
  afterAll(() => app.close());

  const get = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/platform/ledger/reconciliation', headers });

  // Mutation: drop @RequireRoles('platform_admin') (or widen it) so an operator or a player can read it.
  it('is for a platform admin only: operators, staff and players are 403, no token is 401', async () => {
    for (const token of [tokens.operator(), tokens.staff(), tokens.player()]) {
      expect((await get(bearer(token))).statusCode).toBe(403);
    }
    expect((await get({})).statusCode).toBe(401);
    expect(reconciliation.last).not.toHaveBeenCalled();
  });

  // Mutation: describe the record wrongly (drop the mismatch list, the report or the stale flag).
  it('a platform admin acting in a tenant reads the last run: time, accounts checked, mismatches by kind, report, stale', async () => {
    reconciliation.last.mockResolvedValueOnce({ ...RUN });
    const res = await get(bearer(tokens.acting(T)));
    expect(res.statusCode).toBe(200);
    const { last_run } = res.json() as { last_run: typeof RUN };
    expect(ReconciliationRun.parse({ ...last_run, stale: undefined })).toMatchObject({
      status: 'mismatch',
      accounts_checked: 14,
      started_at: '2026-11-21T10:00:00.000Z',
    });
    expect(last_run.mismatches.map((m) => m.kind)).toEqual(['balance_drift']);
    expect(last_run.stale).toBe(false);
  });

  it('answers last_run null when the job has not run for the tenant yet', async () => {
    reconciliation.last.mockResolvedValueOnce(null);
    const res = await get(bearer(tokens.acting(T)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ last_run: null });
  });
});
