import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { enqueueEvent } from '@ex-mio/bus';
import type { EventEnvelope } from '@ex-mio/contracts';
import { runIdempotent, type IdempotentCall, type IdempotentOutcome } from '@ex-mio/idempotency';
import { withTenantTransaction } from '@ex-mio/tenancy';

export const DATA_SOURCE = Symbol('DATA_SOURCE');

/**
 * A transaction handle. Services receive one from `Db` and pass it to
 * repositories; they never see the driver or a connection.
 */
export type Tx = EntityManager;

/**
 * The only way application code gets a transaction.
 *  - `tenantTx`: tenant-scoped (`SET LOCAL app.tenant_id` from the ambient
 *    context). Throws without a tenant. This is the default for domain data.
 *  - `platformTx`: no tenant. Only for platform tables that have no tenant_id
 *    (the tenant registry itself); tenant tables are RLS-protected, so a
 *    platform transaction sees none of their rows.
 */
@Injectable()
export class Db {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  tenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.dataSource, fn);
  }

  /**
   * Tenant-scoped with an explicit tenant (validated as a UUID). For callers that pick the tenant
   * per call, like identity's login and launch flows, where the tenant comes from the Host or a
   * credential key rather than from an ambient request context.
   */
  tenantTxFor<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.dataSource, fn, tenantId);
  }

  platformTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(fn);
  }

  /** Run an effect at most once per idempotency key; see @ex-mio/idempotency. */
  idempotent<T>(call: Omit<IdempotentCall<T>, 'dataSource'>): Promise<IdempotentOutcome<T>> {
    return runIdempotent({ ...call, dataSource: this.dataSource });
  }

  /** Add an event to the outbox in the caller's transaction. */
  publish(tx: Tx, event: EventEnvelope): Promise<void> {
    return enqueueEvent(tx, event);
  }

  async ping(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }
}
