import { currentTenant, InvalidTenantIdError, isTenantId } from './context';

/**
 * Cache key for tenant data: `t:<tenant>:<part>:<part>`. Parts are URL-encoded so
 * a part containing `:` cannot forge another tenant's prefix. Every cached value
 * about a tenant goes through this helper; a bare key is a cross-tenant leak.
 */
export function tenantCacheKey(tenantId: string, ...parts: string[]): string {
  if (!isTenantId(tenantId)) throw new InvalidTenantIdError();
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error('cache key needs at least one non-empty part');
  }
  return ['t', tenantId.toLowerCase(), ...parts.map(encodeURIComponent)].join(':');
}

/** Same, using the ambient tenant. Throws without one. */
export function currentTenantCacheKey(...parts: string[]): string {
  return tenantCacheKey(currentTenant().tenantId, ...parts);
}
