import { Injectable } from '@nestjs/common';
import type { RewardTableDefinition, RuleDefinition } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

type Row = Record<string, unknown>;

/** `SELECT` comes back from TypeORM as rows; `UPDATE ... RETURNING` as `[rows, affected]`. */
const rowsOf = (result: unknown): Row[] =>
  Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as Row[]) : (result as Row[]);

/**
 * Rules and reward tables published by an operator (D-27). Every statement names the tenant it was
 * given, on top of row-level security, and appends a version: the rows are never updated, and each
 * records who published it (`created_by`).
 */
@Injectable()
export class OperatorConfigRepository {
  /** Serialises publishes of one tenant's configuration, so two PUTs never pick the same version. */
  async lock(tx: Tx, tenantId: string): Promise<void> {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `operator-config:${tenantId}`,
    ]);
  }

  /** The wheel of the tenant's most recently published reward table. */
  async activeWheelId(tx: Tx, tenantId: string): Promise<string | undefined> {
    const rows = rowsOf(
      await tx.query(
        `SELECT wheel_id FROM reward_tables
          WHERE tenant_id = $1 ORDER BY created_at DESC, version DESC LIMIT 1`,
        [tenantId],
      ),
    );
    return rows[0]?.wheel_id as string | undefined;
  }

  async wheelExists(tx: Tx, tenantId: string, wheelId: string): Promise<boolean> {
    const rows = rowsOf(
      await tx.query(`SELECT 1 FROM reward_tables WHERE tenant_id = $1 AND wheel_id = $2 LIMIT 1`, [
        tenantId,
        wheelId,
      ]),
    );
    return rows.length > 0;
  }

  async insertWheelVersion(
    tx: Tx,
    input: {
      tenantId: string;
      wheelId: string;
      definition: RewardTableDefinition;
      createdBy: string;
    },
  ): Promise<number> {
    const rows = rowsOf(
      await tx.query(
        `INSERT INTO reward_tables (tenant_id, wheel_id, version, definition, created_by)
         SELECT $1::uuid, $2::uuid, COALESCE(max(version), 0) + 1, $3::jsonb, $4::text
           FROM reward_tables WHERE tenant_id = $1::uuid AND wheel_id = $2::uuid
         RETURNING version`,
        [input.tenantId, input.wheelId, JSON.stringify(input.definition), input.createdBy],
      ),
    );
    return rows[0]!.version as number;
  }

  async insertRuleVersion(
    tx: Tx,
    input: { tenantId: string; ruleId: string; definition: RuleDefinition; createdBy: string },
  ): Promise<number> {
    const rows = rowsOf(
      await tx.query(
        `INSERT INTO rules (tenant_id, rule_id, version, definition, created_by)
         SELECT $1::uuid, $2::text, COALESCE(max(version), 0) + 1, $3::jsonb, $4::text
           FROM rules WHERE tenant_id = $1::uuid AND rule_id = $2::text
         RETURNING version`,
        [input.tenantId, input.ruleId, JSON.stringify(input.definition), input.createdBy],
      ),
    );
    return rows[0]!.version as number;
  }

  async hasAnyRule(tx: Tx, tenantId: string): Promise<boolean> {
    return (
      rowsOf(await tx.query(`SELECT 1 FROM rules WHERE tenant_id = $1 LIMIT 1`, [tenantId]))
        .length > 0
    );
  }
}
