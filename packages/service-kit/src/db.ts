import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { enqueueEvent } from '@ex-mio/bus';
import type { EventEnvelope } from '@ex-mio/contracts';
import { runIdempotent, type IdempotentCall, type IdempotentOutcome } from '@ex-mio/idempotency';
import { withTenantTransaction } from '@ex-mio/tenancy';

export const DATA_SOURCE = Symbol('DATA_SOURCE');

/** The opt-in flag of a platform scan: honoured only by policies, and only with no tenant set. */
export const PLATFORM_SCAN_SETTING = 'app.platform_scan';

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

  /**
   * `scan: true` opts this transaction into the explicit platform-scan flag (`app.platform_scan`),
   * the same flag the work queue uses (WorkQueueScanNoTenant). A policy that honours it still needs
   * NO tenant set, so a tenant transaction never gets it. Only the audit port and sweeper pass it.
   */
  platformTx<T>(fn: (tx: Tx) => Promise<T>, opts?: { scan?: boolean }): Promise<T> {
    if (!opts?.scan) return this.dataSource.transaction(fn);
    return this.dataSource.transaction(async (tx) => {
      await tx.query(`SET LOCAL ${PLATFORM_SCAN_SETTING} = 'on'`);
      return fn(tx);
    });
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
