import { Injectable } from '@nestjs/common';
import { RewardTableDefinition, RuleDefinition, uuidv7 } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { InboundEventsRepository, type InboundEventRow } from '../integrations/ports';
import {
  RulesRepository,
  SpinCreditsRepository,
  SpinsRepository,
  WheelsRepository,
  type NewCredit,
  type RewardTableVersion,
  type SpinCredit,
  type SpinRecord,
  type StoredRule,
} from './repositories';

/**
 * Postgres implementations. Repositories own all SQL. Every statement names `tenant_id` from the
 * ambient tenant on top of row-level security, and every spin-credit statement names `user_id`.
 */

type Row = Record<string, unknown>;

/** `UPDATE ... RETURNING` comes back from TypeORM as `[rows, affected]`; other statements as rows. */
const rowsOf = (result: unknown): Row[] => {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as Row[];
  return result as Row[];
};

const tenantId = (): string => currentTenant().tenantId;

const toCredit = (r: Row): SpinCredit => ({
  id: r.id as string,
  userId: r.user_id as string,
  wheelId: r.wheel_id as string,
  status: r.status as 'available' | 'used',
  sandbox: r.sandbox === true,
});

@Injectable()
export class PgInboundEventsRepository extends InboundEventsRepository {
  async insertIfAbsent(tx: Tx, row: InboundEventRow): Promise<{ inserted: boolean; id: string }> {
    const inserted = rowsOf(
      await tx.query(
        `INSERT INTO inbound_events
           (id, tenant_id, sandbox, source, external_event_id, external_player_hmac, amount_minor, currency, occurred_at)
         VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, sandbox, source, external_event_id) DO NOTHING
         RETURNING id`,
        [
          uuidv7(),
          row.tenantId,
          row.source,
          row.externalEventId,
          row.externalPlayerHmac,
          row.amountMinor,
          row.currency,
          row.occurredAt,
          row.sandbox,
        ],
      ),
    );
    if (inserted[0]) return { inserted: true, id: inserted[0].id as string };
    // The conflicting row is committed (the insert waited for its transaction): read it back.
    const existing = rowsOf(
      await tx.query(
        `SELECT id FROM inbound_events
          WHERE tenant_id = $1 AND sandbox = $4 AND source = $2 AND external_event_id = $3`,
        [row.tenantId, row.source, row.externalEventId, row.sandbox],
      ),
    );
    return { inserted: false, id: existing[0]!.id as string };
  }
}

@Injectable()
export class PgRulesRepository extends RulesRepository {
  async listRules(tx: Tx): Promise<StoredRule[]> {
    const rows = rowsOf(
      await tx.query(
        `SELECT rule_id, version, definition FROM rules WHERE tenant_id = $1 ORDER BY rule_id, version`,
        [tenantId()],
      ),
    );
    return rows.map((r) => ({
      rule_id: r.rule_id as string,
      version: r.version as number,
      definition: RuleDefinition.parse(r.definition),
    }));
  }

  async priorGrantCounts(tx: Tx, userId: string): Promise<Record<string, number>> {
    const rows = rowsOf(
      await tx.query(
        `SELECT rule_id, count(DISTINCT source_event_id)::int AS n
           FROM spin_credits WHERE tenant_id = $1 AND user_id = $2 GROUP BY rule_id`,
        [tenantId(), userId],
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.rule_id as string, r.n as number]));
  }
}

@Injectable()
export class PgSpinCreditsRepository extends SpinCreditsRepository {
  async grant(tx: Tx, rows: NewCredit[]): Promise<NewCredit[]> {
    if (rows.length === 0) return [];
    const params: unknown[] = [];
    const values = rows.map((r) => {
      const base = params.length;
      params.push(
        r.id,
        r.tenantId,
        r.userId,
        r.wheelId,
        r.sourceEventId,
        r.ruleId,
        r.ruleVersion,
        r.seq,
        r.sandbox === true,
      );
      const p = (n: number) => `$${base + n}`;
      return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, 'available')`;
    });
    const inserted = rowsOf(
      await tx.query(
        `INSERT INTO spin_credits
           (id, tenant_id, user_id, wheel_id, source_event_id, rule_id, rule_version, seq, sandbox, status)
         VALUES ${values.join(', ')}
         ON CONFLICT (tenant_id, source_event_id, rule_id, seq) DO NOTHING
         RETURNING id`,
        params,
      ),
    );
    const ids = new Set(inserted.map((r) => r.id as string));
    return rows.filter((r) => ids.has(r.id));
  }

  async consume(
    tx: Tx,
    input: { userId: string; sandbox: boolean; creditId?: string },
  ): Promise<SpinCredit | undefined> {
    const params: unknown[] = [tenantId(), input.userId, input.sandbox];
    let byId = '';
    if (input.creditId !== undefined) {
      params.push(input.creditId);
      byId = 'AND id = $4';
    }
    const rows = rowsOf(
      await tx.query(
        `UPDATE spin_credits SET status = 'used', used_at = now()
          WHERE id = (SELECT id FROM spin_credits
                       WHERE tenant_id = $1 AND user_id = $2 AND sandbox = $3
                         AND status = 'available' ${byId}
                       ORDER BY created_at, id
                       FOR UPDATE SKIP LOCKED LIMIT 1)
            AND status = 'available'
          RETURNING id, user_id, wheel_id, status, sandbox`,
        params,
      ),
    );
    return rows[0] ? toCredit(rows[0]) : undefined;
  }

  async countAvailable(tx: Tx, input: { userId: string; sandbox: boolean }): Promise<number> {
    const rows = rowsOf(
      await tx.query(
        `SELECT count(*)::int AS n FROM spin_credits
          WHERE tenant_id = $1 AND user_id = $2 AND sandbox = $3 AND status = 'available'`,
        [tenantId(), input.userId, input.sandbox],
      ),
    );
    return rows[0]!.n as number;
  }

  async findOwn(
    tx: Tx,
    input: { userId: string; sandbox: boolean; creditId: string },
  ): Promise<SpinCredit | undefined> {
    const rows = rowsOf(
      await tx.query(
        `SELECT id, user_id, wheel_id, status, sandbox FROM spin_credits
          WHERE tenant_id = $1 AND user_id = $2 AND sandbox = $3 AND id = $4`,
        [tenantId(), input.userId, input.sandbox, input.creditId],
      ),
    );
    return rows[0] ? toCredit(rows[0]) : undefined;
  }
}

@Injectable()
export class PgWheelsRepository extends WheelsRepository {
  async activeWheelId(tx: Tx): Promise<string | undefined> {
    const rows = rowsOf(
      await tx.query(
        `SELECT wheel_id FROM reward_tables
          WHERE tenant_id = $1 ORDER BY created_at DESC, version DESC LIMIT 1`,
        [tenantId()],
      ),
    );
    return rows[0]?.wheel_id as string | undefined;
  }

  async activeTable(tx: Tx, wheelId: string): Promise<RewardTableVersion | undefined> {
    const rows = rowsOf(
      await tx.query(
        `SELECT version, definition FROM reward_tables
          WHERE tenant_id = $1 AND wheel_id = $2 ORDER BY version DESC LIMIT 1`,
        [tenantId(), wheelId],
      ),
    );
    const r = rows[0];
    if (!r) return undefined;
    const def = RewardTableDefinition.parse(r.definition);
    return { wheelId, version: r.version as number, segments: def.segments };
  }
}

@Injectable()
export class PgSpinsRepository extends SpinsRepository {
  async findByOperation(
    tx: Tx,
    input: { userId: string; operationId: string },
  ): Promise<SpinRecord | undefined> {
    const rows = rowsOf(
      await tx.query(
        `SELECT id, user_id, credit_id, operation_id, seed_version, table_version, hmac,
                segment_index, segment_label, reward_coins
           FROM spins WHERE tenant_id = $1 AND user_id = $2 AND operation_id = $3`,
        [tenantId(), input.userId, input.operationId],
      ),
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id as string,
      userId: r.user_id as string,
      creditId: r.credit_id as string,
      operationId: r.operation_id as string,
      seedVersion: r.seed_version as number,
      tableVersion: r.table_version as number,
      hmac: r.hmac as string,
      segmentIndex: r.segment_index as number,
      segmentLabel: r.segment_label as string,
      rewardCoins: r.reward_coins as number,
    };
  }

  async insert(tx: Tx, s: SpinRecord): Promise<void> {
    await tx.query(
      `INSERT INTO spins (id, tenant_id, user_id, credit_id, operation_id, seed_version,
                          table_version, hmac, segment_index, segment_label, reward_coins)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        s.id,
        tenantId(),
        s.userId,
        s.creditId,
        s.operationId,
        s.seedVersion,
        s.tableVersion,
        s.hmac,
        s.segmentIndex,
        s.segmentLabel,
        s.rewardCoins,
      ],
    );
  }
}
