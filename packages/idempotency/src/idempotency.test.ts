import type { DataSource } from 'typeorm';
import { runWithTenant } from '@ex-mio/tenancy';
import {
  canonicalJson,
  IdempotencyInFlightError,
  IdempotencyMismatchError,
  requestHash,
  runIdempotent,
} from './index';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

describe('canonical request hash', () => {
  it('ignores key order and undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1, x: undefined }),
    );
  });

  it('differs when a value differs', () => {
    expect(requestHash({ amount: 10 })).not.toBe(requestHash({ amount: 11 }));
  });
});

/** In-memory stand-in for the three statements runIdempotent issues. */
function fakeDataSource(state: {
  lock: boolean;
  row?: { request_hash: string; response_status: number; response_body: unknown };
}) {
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SET LOCAL')) return [];
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ locked: state.lock }];
      if (sql.startsWith('SELECT')) return state.row ? [state.row] : [];
      if (sql.includes('INSERT INTO "idempotency_keys"')) {
        state.row = {
          request_hash: String(params?.[4]),
          response_status: Number(params?.[5]),
          response_body: JSON.parse(String(params?.[6])),
        };
      }
      return [];
    }),
  };
  return {
    dataSource: {
      transaction: async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager),
    } as unknown as DataSource,
    manager,
  };
}

const run = (ds: DataSource, request: unknown, effect: jest.Mock, key = 'k1', principalId = 'p1') =>
  runWithTenant({ tenantId: TENANT }, () =>
    runIdempotent({ dataSource: ds, principalId, operation: 'op', key, request, effect }),
  );

describe('runIdempotent', () => {
  it('runs the effect once and replays the stored response for an identical retry', async () => {
    const state = { lock: true } as Parameters<typeof fakeDataSource>[0];
    const { dataSource } = fakeDataSource(state);
    const effect = jest.fn(async () => ({ status: 201, body: { id: 'x' } }));
    const first = await run(dataSource, { a: 1, b: 2 }, effect);
    const second = await run(dataSource, { b: 2, a: 1 }, effect);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: 201, replayed: false });
    expect(second).toMatchObject({ status: 201, body: { id: 'x' }, replayed: true });
  });

  it('422 when the same key comes with a different body, and the effect does not run', async () => {
    const state = { lock: true } as Parameters<typeof fakeDataSource>[0];
    const { dataSource } = fakeDataSource(state);
    const effect = jest.fn(async () => ({ status: 201, body: {} }));
    await run(dataSource, { a: 1 }, effect);
    await expect(run(dataSource, { a: 2 }, effect)).rejects.toBeInstanceOf(
      IdempotencyMismatchError,
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('409 when another attempt holds the lock, and the effect does not run', async () => {
    const { dataSource } = fakeDataSource({ lock: false });
    const effect = jest.fn();
    await expect(run(dataSource, { a: 1 }, effect)).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it('refuses to run without a tenant', async () => {
    const { dataSource } = fakeDataSource({ lock: true });
    await expect(
      runIdempotent({
        dataSource,
        principalId: 'p',
        operation: 'op',
        key: 'k',
        request: {},
        effect: jest.fn(),
      }),
    ).rejects.toThrow(/tenant/);
  });
});
