import { Logger } from '@nestjs/common';
import type { EventEnvelope } from '@ex-mio/contracts';
import type { Db, Tx } from './db';

/*
 * Two-step audit of an allowed acting or internal request (decision D-11, D-21 M1).
 *
 *   1. Before the handler: the entry point inserts the event into `audit_intents`, a table the
 *      outbox relay never reads, in its own transaction. If that fails the request gets 503.
 *   2. After the response: `finalize` deletes the intent and writes the event, with the real
 *      decision and status, to the outbox, in ONE transaction. Only now can the relay publish it.
 *   3. A sweeper publishes every intent older than 60 s as `decision: aborted` (the handler never
 *      finished, or the process died), so no crash leaves a wrong "allowed".
 *
 * Nothing reaches the outbox before step 2 or 3. The DELETE ... RETURNING is the choke point: a
 * finalize and a sweep that race on the same row cannot both publish it.
 */

export const AUDIT_INTENT_SWEEP_AFTER_SECONDS = 60;
export const AUDIT_INTENT_SWEEP_EVERY_MS = 10_000;

/** The runtime role needs exactly this on `audit_intents` (the table has no tenant_id and no RLS). */
export const AUDIT_INTENTS_GRANTS = ['SELECT', 'INSERT', 'DELETE'] as const;

/** DDL for one service's migration. The table is owned by the migration role. */
export async function createAuditIntentsTable(q: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await q.query(`
    CREATE TABLE "audit_intents" (
      "event_id" uuid PRIMARY KEY,
      "envelope" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )`);
  await q.query(`CREATE INDEX "audit_intents_created" ON "audit_intents" ("created_at")`);
}

export async function dropAuditIntentsTable(q: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await q.query(`DROP TABLE "audit_intents"`);
}

/** Raised by `finalize` when the intent is gone: the sweeper already published it as aborted. */
export class AuditIntentGoneError extends Error {
  constructor(eventId: string) {
    super(
      `audit intent ${eventId} is gone (swept as aborted); its final outcome was not published`,
    );
  }
}

export type OutboxAuditPort = ((event: EventEnvelope) => Promise<void>) & {
  finalize: (event: EventEnvelope) => Promise<void>;
  /** Publish an event whose outcome is already known (a guard refusal) once, final, no intent. */
  publishFinal: (event: EventEnvelope) => Promise<void>;
  /** Publish intents older than `olderThanSeconds` as aborted; returns how many. */
  sweep: (olderThanSeconds?: number) => Promise<number>;
};

type Rows = { event_id: string; envelope: EventEnvelope }[];

/** typeorm's `query` returns the rows, or `[rows, count]` for DELETE ... RETURNING. */
const rowsOf = (res: unknown): Rows => {
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0] as Rows;
  return res as Rows;
};

export function createOutboxAuditPort(getDb: () => Db): OutboxAuditPort {
  const port = (async (event: EventEnvelope): Promise<void> => {
    await getDb().platformTx((tx: Tx) =>
      tx.query(`INSERT INTO "audit_intents" ("event_id", "envelope") VALUES ($1, $2)`, [
        event.event_id,
        JSON.stringify(event),
      ]),
    );
  }) as OutboxAuditPort;

  // A refusal made by the entry point itself has a known outcome and never ran a handler: it goes
  // straight to the outbox, final, with no intent (F1). The intent path is reachable only from the
  // port call; this is the other way in, and it has no provisional state to leave behind.
  port.publishFinal = async (event) => {
    const db = getDb();
    await db.platformTx((tx: Tx) => db.publish(tx, event));
  };

  port.finalize = async (event) => {
    const db = getDb();
    await db.platformTx(async (tx: Tx) => {
      const gone = rowsOf(
        await tx.query(`DELETE FROM "audit_intents" WHERE "event_id" = $1 RETURNING "event_id"`, [
          event.event_id,
        ]),
      );
      if (gone.length !== 1) throw new AuditIntentGoneError(event.event_id);
      await db.publish(tx, event);
    });
  };

  port.sweep = async (olderThanSeconds = AUDIT_INTENT_SWEEP_AFTER_SECONDS) => {
    const db = getDb();
    return db.platformTx(async (tx: Tx) => {
      const old = rowsOf(
        await tx.query(
          `DELETE FROM "audit_intents" WHERE "created_at" < now() - make_interval(secs => $1)
           RETURNING "event_id", "envelope"`,
          [olderThanSeconds],
        ),
      );
      for (const row of old) {
        const event = row.envelope;
        const payload = event.payload as { decision: string; status: number };
        payload.decision = 'aborted';
        payload.status = 500;
        await db.publish(tx, event);
      }
      return old.length;
    });
  };

  return port;
}

const log = new Logger('AuditIntents');

/** Runs `port.sweep` on a timer until `stop()`. A failed sweep is logged and retried next tick. */
export function startAuditSweeper(
  port: Pick<OutboxAuditPort, 'sweep'>,
  everyMs = AUDIT_INTENT_SWEEP_EVERY_MS,
): () => void {
  const timer = setInterval(() => {
    port.sweep().catch((err: unknown) => log.error(`audit sweep failed: ${String(err)}`));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export const logAuditFinalizeFailure = (err: unknown): void =>
  log.error(`audit finalize failed (the sweeper will publish it as aborted): ${String(err)}`);
