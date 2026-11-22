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
  connection: { subscribers: unknown[] };
}

/** The part of a TypeORM `EntityManager` this needs. */
export interface TxLike {
  queryRunner?: QueryRunnerLike | undefined;
}

type Effect = () => void;

const pending = new WeakMap<object, Effect[]>();
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
    for (const effect of effects ?? []) {
      try {
        effect();
      } catch {
        // an analytics side effect never fails a committed transaction
      }
    }
  },
  afterTransactionRollback(event: TransactionEvent): void {
    if (event.queryRunner.isTransactionActive) return;
    pending.delete(event.queryRunner);
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
  list.push(effect);
  pending.set(runner, list);
}
