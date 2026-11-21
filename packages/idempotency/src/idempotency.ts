import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  currentTenant,
  enableTenantRls,
  disableTenantRls,
  withTenantTransaction,
} from '@ex-mio/tenancy';
import { requestHash } from './canonical';

export class IdempotencyInFlightError extends Error {
  readonly httpStatus = 409;
  constructor() {
    super('a request with this idempotency key is still being processed');
    this.name = 'IdempotencyInFlightError';
  }
}

export class IdempotencyMismatchError extends Error {
  readonly httpStatus = 422;
  constructor() {
    super('this idempotency key was already used with a different request body');
    this.name = 'IdempotencyMismatchError';
  }
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

export interface IdempotentCall<T> {
  dataSource: DataSource;
  /** Who acts. Part of the scope: the same key from two principals is two requests. */
  principalId: string;
  /** What is being done, e.g. `payments.credit`. Part of the scope. */
  operation: string;
  /** The client's `Idempotency-Key`. */
  key: string;
  /** The parsed request; hashed in canonical form to detect a changed body. */
  request: unknown;
  /** The effect. Runs in the SAME transaction that stores the result. */
  effect: (manager: EntityManager) => Promise<IdempotentResult<T>>;
}

export interface IdempotentOutcome<T> extends IdempotentResult<T> {
  /** True when the stored response of an earlier identical request was returned. */
  replayed: boolean;
}

/**
 * Run `effect` at most once per (tenant, principal, operation, key).
 *
 *  - The tenant comes from the ambient context (fails closed without one).
 *  - A transaction-scoped advisory lock on the scope serializes concurrent
 *    attempts: a second one that cannot take the lock gets 409 (in flight)
 *    instead of waiting or running twice.
 *  - If a stored row exists: same canonical request hash replays the stored
 *    response; a different hash is 422.
 *  - Otherwise the effect runs and its response is stored in the same
 *    transaction, so there is no state where the effect committed but the key
 *    did not (a retry would repeat it) or the key committed but the effect did
 *    not (a retry would be answered with a result that never happened).
 */
export async function runIdempotent<T>(call: IdempotentCall<T>): Promise<IdempotentOutcome<T>> {
  const { tenantId } = currentTenant();
  const hash = requestHash(call.request);
  const scope = [tenantId, call.principalId, call.operation, call.key].join('\u0000');

  return withTenantTransaction(call.dataSource, async (manager) => {
    const lock: { locked: boolean }[] = await manager.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS "locked"`,
      [scope],
    );
    if (!lock[0]?.locked) throw new IdempotencyInFlightError();

    const existing: { request_hash: string; response_status: number; response_body: unknown }[] =
      await manager.query(
        `SELECT "request_hash", "response_status", "response_body" FROM "idempotency_keys"
         WHERE "principal_id" = $1 AND "operation" = $2 AND "key" = $3`,
        [call.principalId, call.operation, call.key],
      );
    const row = existing[0];
    if (row) {
      if (row.request_hash !== hash) throw new IdempotencyMismatchError();
      return { status: row.response_status, body: row.response_body as T, replayed: true };
    }

    const result = await call.effect(manager);
    await manager.query(
      `INSERT INTO "idempotency_keys"
         ("tenant_id", "principal_id", "operation", "key", "request_hash", "response_status", "response_body")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        call.principalId,
        call.operation,
        call.key,
        hash,
        result.status,
        JSON.stringify(result.body),
      ],
    );
    return { ...result, replayed: false };
  });
}

/** Migration helper: the table that stores results. Tenant-isolated by RLS. */
export async function createIdempotencyTable(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE "idempotency_keys" (
      "tenant_id" uuid NOT NULL,
      "principal_id" text NOT NULL,
      "operation" text NOT NULL,
      "key" text NOT NULL,
      "request_hash" text NOT NULL,
      "response_status" integer NOT NULL,
      "response_body" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("tenant_id", "principal_id", "operation", "key")
    )`);
  await enableTenantRls(queryRunner, 'idempotency_keys');
}

export async function dropIdempotencyTable(queryRunner: QueryRunner): Promise<void> {
  await disableTenantRls(queryRunner, 'idempotency_keys');
  await queryRunner.query(`DROP TABLE "idempotency_keys"`);
}
