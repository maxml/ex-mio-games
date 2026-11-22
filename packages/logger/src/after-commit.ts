/**
 * Run a side effect (a product event) only after the surrounding database transaction has
 * committed. A product event states a business fact, so it must not be written before the fact is
 * durable, and a rolled-back transaction must leave no line at all.
 *
 * It works on the TypeORM `EntityManager` a service already holds inside `Db.tenantTx`,
 * `Db.idempotent` or the inbox consumer: the manager's `queryRunner` knows its connection, and a
 * subscriber on that connection hears the commit and the rollback. Types are structural so this
 * package keeps no dependency on typeorm. Without an active transaction the effect runs at once.
 */

interface QueryRunnerLike {
  isTransactionActive: boolean;
  /** TypeORM's nesting depth: 1 in the outer transaction, +1 per savepoint. */
  transactionDepth?: number | undefined;
  connection: { subscribers: unknown[] };
}

/** The part of a TypeORM `EntityManager` this needs. */
export interface TxLike {
  queryRunner?: QueryRunnerLike | undefined;
}

type Effect = () => void;
/** An effect and the transaction depth it was queued at (a savepoint is one level deeper). */
interface Queued {
  effect: Effect;
  depth: number;
}

const pending = new WeakMap<object, Queued[]>();
const subscribed = new WeakSet<object>();

interface TransactionEvent {
  queryRunner: QueryRunnerLike;
}

const subscriber = {
  afterTransactionCommit(event: TransactionEvent): void {
    // a released savepoint of a nested transaction is not the commit
    if (event.queryRunner.isTransactionActive) return;
    const effects = pending.get(event.queryRunner);
    pending.delete(event.queryRunner);
    for (const { effect } of effects ?? []) {
      try {
        effect();
      } catch {
        // an analytics side effect never fails a committed transaction
      }
    }
  },
  afterTransactionRollback(event: TransactionEvent): void {
    const runner = event.queryRunner;
    if (!runner.isTransactionActive) {
      pending.delete(runner); // the outer transaction rolled back: nothing leaves
      return;
    }
    // A savepoint rolled back while the outer transaction goes on. TypeORM has already lowered the
    // depth, so whatever was queued deeper than that belonged to the rolled-back savepoint.
    const depth = runner.transactionDepth;
    if (depth === undefined) return;
    const kept = (pending.get(runner) ?? []).filter((q) => q.depth <= depth);
    pending.set(runner, kept);
  },
};

export function afterCommit(tx: TxLike, effect: Effect): void {
  const runner = tx.queryRunner;
  if (!runner || !runner.isTransactionActive) {
    effect();
    return;
  }
  if (!subscribed.has(runner.connection)) {
    runner.connection.subscribers.push(subscriber);
    subscribed.add(runner.connection);
  }
  const list = pending.get(runner) ?? [];
  list.push({ effect, depth: runner.transactionDepth ?? 1 });
  pending.set(runner, list);
}
