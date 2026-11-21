import 'reflect-metadata';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import type { DataSource } from 'typeorm';
import {
  currentTenant,
  currentTenantCacheKey,
  enableTenantRlsSql,
  headerTenantResolver,
  Public,
  runWithTenant,
  tenantCacheKey,
  TenantContextMissingError,
  TenantGuard,
  TenantInterceptor,
  tryTenantContext,
  withTenantTransaction,
} from './index';

const T1 = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const T2 = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';

function fakeContext(headers: Record<string, string>, handler: object = () => undefined) {
  const request = { headers };
  const ctx = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('ambient context', () => {
  it('fails closed without a tenant', () => {
    expect(() => currentTenant()).toThrow(TenantContextMissingError);
    expect(tryTenantContext()).toBeUndefined();
  });

  it('keeps tenants apart across concurrent async flows', async () => {
    const seen = await Promise.all(
      [T1, T2].map((tenantId) =>
        runWithTenant({ tenantId }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          return currentTenant().tenantId;
        }),
      ),
    );
    expect(seen).toEqual([T1, T2]);
  });

  it('rejects a tenant id that is not a UUID', () => {
    expect(() => runWithTenant({ tenantId: "x'; DROP TABLE users;--" }, () => 1)).toThrow();
  });
});

describe('TenantGuard', () => {
  const guard = new TenantGuard(new Reflector(), headerTenantResolver);

  it('denies a request without a tenant', () => {
    expect(() => guard.canActivate(fakeContext({}).ctx)).toThrow(UnauthorizedException);
  });

  it('denies a malformed tenant header', () => {
    expect(() => guard.canActivate(fakeContext({ 'x-tenant-id': 'abc' }).ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('admits a valid tenant', () => {
    expect(guard.canActivate(fakeContext({ 'x-tenant-id': T1 }).ctx)).toBe(true);
  });

  it('admits a @Public route without a tenant', () => {
    class Controller {
      @Public()
      live() {
        return 'ok';
      }
    }
    const handler = Controller.prototype.live;
    expect(guard.canActivate(fakeContext({}, handler).ctx)).toBe(true);
  });

  it('interceptor opens the context for the handler', async () => {
    const { ctx } = fakeContext({ 'x-tenant-id': T1 });
    guard.canActivate(ctx);
    const out = await lastValueFrom(
      new TenantInterceptor().intercept(ctx, {
        handle: () => of(currentTenant().tenantId),
      }) as never,
    );
    expect(out).toBe(T1);
  });
});

describe('withTenantTransaction', () => {
  function fakeDataSource(queries: string[]) {
    const manager = { query: jest.fn(async (sql: string) => void queries.push(sql)) };
    const dataSource = {
      transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => fn(manager)),
    };
    return dataSource as unknown as DataSource;
  }

  it('sets the tenant before the callback runs', async () => {
    const queries: string[] = [];
    await runWithTenant({ tenantId: T1 }, () =>
      withTenantTransaction(fakeDataSource(queries), async (m) => void (await m.query('SELECT 1'))),
    );
    expect(queries).toEqual([`SET LOCAL app.tenant_id = '${T1}'`, 'SELECT 1']);
  });

  it('throws before opening a transaction when there is no tenant', async () => {
    const queries: string[] = [];
    const ds = fakeDataSource(queries);
    await expect(withTenantTransaction(ds, async () => 1)).rejects.toThrow(
      TenantContextMissingError,
    );
    expect((ds.transaction as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('refuses a malformed explicit tenant id', async () => {
    await expect(
      withTenantTransaction(fakeDataSource([]), async () => 1, "x'--"),
    ).rejects.toThrow();
  });
});

describe('rls sql', () => {
  it('enables, forces and checks writes', () => {
    const sql = enableTenantRlsSql('coin_credits').join('\n');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('WITH CHECK');
    expect(sql).toContain("NULLIF(current_setting('app.tenant_id', true), '')::uuid");
  });

  it('rejects an unsafe table name', () => {
    expect(() => enableTenantRlsSql('x; DROP TABLE y')).toThrow();
  });
});

describe('cache keys', () => {
  it('prefixes with the tenant', () => {
    expect(tenantCacheKey(T1, 'wallet', 'p1')).toBe(`t:${T1}:wallet:p1`);
  });

  it('cannot be tricked into another tenant prefix', () => {
    const key = tenantCacheKey(T1, `x:${T2}`);
    expect(key.startsWith(`t:${T1}:`)).toBe(true);
    expect(key.split(':')).toHaveLength(3); // `t`, tenant, one encoded part
  });

  it('needs a tenant and a part', () => {
    expect(() => currentTenantCacheKey('a')).toThrow(TenantContextMissingError);
    expect(() => tenantCacheKey(T1)).toThrow();
  });
});
