import type { DataSource, EntityManager } from 'typeorm';
import { currentTenant, InvalidTenantIdError, isTenantId } from './context';

/** The Postgres setting that row-level-security policies compare `tenant_id` with. */
export const TENANT_SETTING = 'app.tenant_id';

/**
 * Run `fn` in a transaction whose connection has `SET LOCAL app.tenant_id`. The
 * setting is local to the transaction: it disappears at COMMIT or ROLLBACK, so a
 * pooled connection never carries one request's tenant into the next.
 *
 * The tenant comes from the ambient context unless one is passed explicitly
 * (message consumers pass the envelope's `tenant_id`). With neither, this throws
 * before any query runs.
 */
export async function withTenantTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  tenantId?: string,
): Promise<T> {
  const id = tenantId ?? currentTenant().tenantId;
  if (!isTenantId(id)) throw new InvalidTenantIdError();
  return dataSource.transaction(async (manager) => {
    // The id is validated as a UUID above, so it cannot carry quotes; SET does
    // not accept bind parameters, which is why this is a literal.
    await manager.query(`SET LOCAL ${TENANT_SETTING} = '${id}'`);
    return fn(manager);
  });
}
