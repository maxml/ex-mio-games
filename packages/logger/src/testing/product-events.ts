import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { TxLike } from '../after-commit';
import { createLogger } from '../logger';
import { setProductEventLogger } from '../product-event';

/**
 * Test helper for service tests: routes `emitProductEvent` into memory and validates every
 * captured line against the vendored Varta schema (ajv). A dropped event (the emitter's
 * `product_event_dropped` warn) fails the test, so a service cannot "pass" by emitting garbage.
 * Not part of the production build (`src/testing` is excluded from tsc).
 */
const schema = JSON.parse(
  readFileSync(
    join(__dirname, '../../../contracts/schemas/varta-product-event.schema.json'),
    'utf8',
  ),
) as object;
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

/**
 * A stand-in for the transaction a service runs in. It is driven the way TypeORM's broadcaster
 * drives a real query runner: `commit()` / `rollback()` end the transaction and call the
 * connection's subscribers, so `afterCommit` effects run only after `commit()` and never after
 * `rollback()`. (The real-Postgres path is the same subscriber contract.)
 */
export function fakeTransaction(): {
  tx: TxLike;
  commit(): Promise<void>;
  rollback(): Promise<void>;
} {
  const subscribers: Array<Record<string, ((e: unknown) => void) | undefined>> = [];
  const runner = { isTransactionActive: true, connection: { subscribers } };
  const end = (hook: string) => async (): Promise<void> => {
    runner.isTransactionActive = false;
    for (const s of subscribers) s[hook]?.({ queryRunner: runner });
  };
  return {
    tx: { queryRunner: runner },
    commit: end('afterTransactionCommit'),
    rollback: end('afterTransactionRollback'),
  };
}

/** Run `fn` in a fake transaction: commit when it resolves, roll back when it throws. */
export async function inFakeTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  const t = fakeTransaction();
  try {
    const result = await fn(t.tx as never);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export type CapturedProductEvent = Record<string, unknown> & {
  event: string;
  tenant_id: string;
  actor_type: string;
  props?: Record<string, string | number | boolean>;
};

export interface ProductEventCapture {
  /** The product_event lines written so far; each is checked against the Varta schema. */
  events(): CapturedProductEvent[];
  /** Forget what was captured (between steps of one test). */
  clear(): void;
  /** Point the emitter back at the default logger. */
  stop(): void;
}

export function captureProductEvents(): ProductEventCapture {
  let chunks: string[] = [];
  const logger = createLogger(
    { name: 'analytics-test', level: 'info' },
    { write: (s) => void chunks.push(s) },
  );
  setProductEventLogger(logger);
  return {
    events() {
      const lines = chunks.map((c) => JSON.parse(c) as Record<string, unknown>);
      const dropped = lines.filter((l) => l.msg === 'product_event_dropped');
      if (dropped.length > 0) {
        throw new Error(`product event dropped: ${JSON.stringify(dropped)}`);
      }
      const events = lines.filter((l) => l.kind === 'product_event');
      for (const line of events) {
        // VAR-6: the collector strips these from an event line; none may be emitted.
        for (const k of ['msg', 'pid', 'hostname', 'time']) {
          if (k in line) throw new Error(`product event line carries the stripped key ${k}`);
        }
        if (!validate(line)) {
          throw new Error(
            `line breaks the Varta schema: ${JSON.stringify(validate.errors)} ${JSON.stringify(line)}`,
          );
        }
      }
      return events as CapturedProductEvent[];
    },
    clear() {
      chunks = [];
    },
    stop() {
      setProductEventLogger(undefined);
    },
  };
}
