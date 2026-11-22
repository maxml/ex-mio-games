import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  /** The tenant every read and write in this async flow belongs to. */
  tenantId: string;
  /** Who is acting (player, operator, service). Optional for system flows. */
  principalId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown whenever tenant-scoped code runs without a tenant. It never defaults. */
export class TenantContextMissingError extends Error {
  constructor() {
    super('no tenant context: refusing to run tenant-scoped code without one');
    this.name = 'TenantContextMissingError';
  }
}

export class InvalidTenantIdError extends Error {
  constructor() {
    super('tenant id is not a UUID');
    this.name = 'InvalidTenantIdError';
  }
}

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` with `ctx` as the ambient tenant. An invalid tenant id throws here. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  if (!isTenantId(ctx.tenantId)) throw new InvalidTenantIdError();
  return storage.run({ ...ctx }, fn);
}

/** The ambient tenant, or `undefined`. For code that genuinely may run without one. */
export function tryTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** The ambient tenant. Fails closed: throws when there is none. */
export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new TenantContextMissingError();
  return ctx;
}
