import { afterCommit, emitProductEventAs, type ProductAuth } from '@ex-mio/logger';
import type { ProductEventInput } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';
import { tryCurrentAuth } from '@ex-mio/service-kit';
import { tryTenantContext } from '@ex-mio/tenancy';

/**
 * The actor of a payments event: the verified AuthContext of the request when there is one, else
 * the tenant context's principal (an operator), else the payments service itself (a provider
 * webhook has no caller). The tenant is always the tenant of the business row.
 */
function actorOf(tenantId: string): ProductAuth {
  const auth = tryCurrentAuth();
  if (auth) return auth;
  const principalId = tryTenantContext()?.principalId;
  // Payments events here are billing and operator events: production-only by D-13 (metering
  // excludes sandbox), so the actor's environment is production, stated and not defaulted.
  if (principalId) {
    return { mode: 'user', tenantId, principalId, roles: ['operator_admin'], sandbox: false };
  }
  return {
    mode: 'service',
    tenantId,
    principalId: 'payments',
    roles: [],
    service: 'payments',
    sandbox: false,
  };
}

/**
 * Emit a product event once the transaction `tx` has committed. A rollback, or a replayed
 * idempotent request whose effect never ran, leaves no line.
 */
export function emitAfterCommit(
  tx: Tx,
  tenantId: string,
  event: Pick<ProductEventInput, 'event' | 'props'>,
): void {
  const actor = actorOf(tenantId);
  afterCommit(tx, () => emitProductEventAs(actor, { ...event, tenant_id: tenantId }));
}
