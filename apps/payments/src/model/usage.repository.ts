import { Injectable } from '@nestjs/common';
import type { Tx } from '@ex-mio/service-kit';

type Row = Record<string, unknown>;

export interface UsageReportRow {
  period: string;
  quantity: number;
  idempotencyKey: string;
}

/** Data access of usage metering. Tenant rows only; every statement is parameterised. */
@Injectable()
export class UsageRepository {
  /** Count an event once: false when `(tenant_id, event_id)` was already counted. */
  async markCounted(tx: Tx, tenantId: string, eventId: string): Promise<boolean> {
    const rows = (await tx.query(
      `INSERT INTO usage_events (tenant_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`,
      [tenantId, eventId],
    )) as Row[];
    return rows.length > 0;
  }

  async addSpin(tx: Tx, tenantId: string, period: string): Promise<void> {
    await tx.query(
      `INSERT INTO usage_meters (tenant_id, period, metric, quantity) VALUES ($1, $2, 'spins', 1)
       ON CONFLICT (tenant_id, period, metric) DO UPDATE SET quantity = usage_meters.quantity + 1`,
      [tenantId, period],
    );
  }

  async addActivePlayer(
    tx: Tx,
    tenantId: string,
    period: string,
    playerKey: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO usage_players (tenant_id, period, player_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenantId, period, playerKey],
    );
  }

  async totals(
    tx: Tx,
    tenantId: string,
    period: string,
  ): Promise<{ spins: number; players: number }> {
    const spins = (await tx.query(
      `SELECT quantity FROM usage_meters WHERE tenant_id = $1 AND period = $2 AND metric = 'spins'`,
      [tenantId, period],
    )) as Row[];
    const players = (await tx.query(
      `SELECT count(*)::int AS n FROM usage_players WHERE tenant_id = $1 AND period = $2`,
      [tenantId, period],
    )) as Row[];
    return { spins: Number(spins[0]?.quantity ?? 0), players: Number(players[0]?.n ?? 0) };
  }

  async reportOf(tx: Tx, tenantId: string, period: string): Promise<UsageReportRow | null> {
    const rows = (await tx.query(
      `SELECT period, quantity, idempotency_key FROM usage_reports WHERE tenant_id = $1 AND period = $2`,
      [tenantId, period],
    )) as Row[];
    const r = rows[0];
    return r
      ? {
          period: r.period as string,
          quantity: Number(r.quantity),
          idempotencyKey: r.idempotency_key as string,
        }
      : null;
  }

  async insertReport(tx: Tx, tenantId: string, report: UsageReportRow): Promise<void> {
    await tx.query(
      `INSERT INTO usage_reports (tenant_id, period, quantity, idempotency_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, report.period, report.quantity, report.idempotencyKey],
    );
  }
}
