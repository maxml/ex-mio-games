import { Injectable } from '@nestjs/common';
import { runWithTenant } from '@ex-mio/tenancy';
import { parseEvent, uuidv7, type AuditEntry, type EventEnvelope } from '@ex-mio/contracts';
import type { AuditRow, Clock, Repos, Tx, UnitOfWork } from '../model/ports';

const toEntry = (r: AuditRow): AuditEntry =>
  ({
    id: r.id,
    occurred_at: r.occurred_at,
    actor_user_id: r.actor_user_id,
    actor_tenant_id: r.actor_tenant_id,
    acting_tenant_id: r.acting_tenant_id,
    action: r.action,
    reason: r.reason,
    service: r.service,
    route: r.route,
    decision: r.decision,
    caller_service: r.caller_service,
  }) as AuditEntry;

/**
 * The audit log of one operator tenant. Two kinds of rows share it and are told apart by `action`:
 * permission-level rows written by `AccessService.authorize` (action = the permission), and
 * request-level rows consumed from `audit.acting_request` / `audit.service_call` (N9).
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly clock: Clock,
  ) {}

  /** A permission-level row, in the acting tenant. */
  async record(entry: {
    tenantId: string;
    actorUserId: string;
    actorTenantId: string;
    actingTenantId: string;
    action: string;
    reason: string;
  }): Promise<void> {
    // acting.start runs in the platform admin's own tenant context while the row belongs to the
    // target tenant. This write is the one place that deliberately enters the target tenant, so it
    // opens that context for this single transaction instead of switching mid-flow (F9).
    await runWithTenant({ tenantId: entry.tenantId, principalId: entry.actorUserId }, () =>
      this.uow.run(entry.tenantId, (tx) =>
        this.repos.audit.insert(tx, {
          tenant_id: entry.tenantId,
          id: uuidv7(),
          occurred_at: new Date(this.clock.now() * 1000).toISOString(),
          actor_user_id: entry.actorUserId,
          actor_tenant_id: entry.actorTenantId,
          acting_tenant_id: entry.actingTenantId,
          action: entry.action,
          reason: entry.reason,
          service: null,
          route: null,
          decision: null,
          caller_service: null,
        }),
      ),
    );
  }

  async list(tenantId: string): Promise<AuditEntry[]> {
    const rows = await this.uow.run(tenantId, (tx) => this.repos.audit.list(tx, tenantId));
    return rows.map(toEntry);
  }

  /** Consumer of `audit.acting_request` and `audit.service_call`: one row per event id. */
  async handle(raw: EventEnvelope, tx?: Tx): Promise<void> {
    const event = parseEvent(raw);
    const p = event.payload as Record<string, string>;
    let row: AuditRow;
    if (event.type === 'audit.acting_request') {
      row = {
        tenant_id: event.tenant_id,
        id: event.event_id,
        occurred_at: p.occurred_at ?? event.occurred_at,
        actor_user_id: p.actor_user_id ?? null,
        actor_tenant_id: p.actor_tenant_id ?? null,
        acting_tenant_id: p.acting_tenant_id ?? null,
        action: 'acting.request',
        reason: p.reason ?? '',
        service: p.service ?? null,
        route: p.route ?? null,
        decision: p.decision ?? null,
        caller_service: null,
      };
    } else if (event.type === 'audit.service_call') {
      row = {
        tenant_id: event.tenant_id,
        id: event.event_id,
        occurred_at: p.occurred_at ?? event.occurred_at,
        actor_user_id: null,
        actor_tenant_id: null,
        acting_tenant_id: null,
        action: 'service.call',
        reason: '',
        service: p.service ?? null,
        route: p.route ?? null,
        decision: p.decision ?? null,
        caller_service: p.caller_service ?? null,
      };
    } else {
      return; // not ours; the queue only binds the two audit types
    }
    if (tx) await this.repos.audit.insert(tx, row);
    else await this.uow.run(row.tenant_id, (t) => this.repos.audit.insert(t, row));
  }
}
