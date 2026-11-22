import type { EventEnvelope } from '@ex-mio/contracts';
import type {
  DataSource,
  EntityManager,
  EntitySubscriberInterface,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
} from 'typeorm';

/**
 * Pushes leave only after the transaction that handled the bus event commits. The handler queues
 * an event against its transaction (`queue`); TypeORM's `afterTransactionCommit` flushes the queue,
 * `afterTransactionRollback` drops it. So a rollback never shows uncommitted state, and a
 * redelivery of a rolled-back event pushes once (the inbox row rolled back with it), while a
 * redelivery of a committed one is a duplicate the inbox skips before the handler runs.
 *
 * The queue is keyed by the transaction's query runner, so concurrent transactions never mix.
 */
export class PostCommitPushes {
  private readonly pending = new WeakMap<QueryRunner, EventEnvelope[]>();
  private readonly hooked = new WeakSet<DataSource>();

  constructor(private readonly deliver: (event: EventEnvelope) => void) {}

  /** Queue `event` for after `manager`'s transaction commits. Throws if `manager` is not in one. */
  queue(manager: EntityManager, event: EventEnvelope): void {
    const runner = manager.queryRunner;
    if (!runner?.isTransactionActive) {
      throw new Error('realtime push must be queued inside a transaction');
    }
    this.hook(manager.connection);
    const list = this.pending.get(runner);
    if (list) list.push(event);
    else this.pending.set(runner, [event]);
  }

  private hook(connection: DataSource): void {
    if (this.hooked.has(connection)) return;
    this.hooked.add(connection);
    const subscriber: EntitySubscriberInterface = {
      afterTransactionCommit: (e: TransactionCommitEvent) => {
        const list = this.pending.get(e.queryRunner);
        this.pending.delete(e.queryRunner);
        for (const event of list ?? []) this.deliver(event);
      },
      afterTransactionRollback: (e: TransactionRollbackEvent) => {
        this.pending.delete(e.queryRunner);
      },
    };
    connection.subscribers.push(subscriber);
  }
}
