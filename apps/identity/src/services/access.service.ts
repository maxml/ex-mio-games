import { Injectable } from '@nestjs/common';
import {
  ACTING_DENIED_ACTIONS,
  ACTIONS,
  COIN_VALUE_ACTIONS,
  PLATFORM_TENANT_ID,
  type AccessTokenClaims,
  type Action,
  type Role,
} from '@ex-mio/contracts';
import { AuthorizationRefused } from '@ex-mio/service-kit';
import { AuditService } from './audit.service';

export interface Subject {
  userId: string;
  tenantId: string;
  roles: Role[];
  acting?: { tenantId: string; reason: string };
}

export interface ObjectRef {
  tenant_id: string;
  user_id?: string;
}

/** The verified token as a subject, exactly as a controller builds it. */
export function subjectOf(claims: AccessTokenClaims): Subject {
  return {
    userId: claims.sub,
    tenantId: claims.tid.toLowerCase(),
    roles: claims.roles,
    ...(claims.act
      ? { acting: { tenantId: claims.act.tenant_id.toLowerCase(), reason: claims.act.reason } }
      : {}),
  };
}

/** The tenant a subject's requests run in: the acting tenant for an acting session, else its own. */
export const effectiveTenant = (s: Subject): string => s.acting?.tenantId ?? s.tenantId;

/** The coin commands that move value: no role holds them, they belong to services (D-1). */
const COIN_VALUE: ReadonlySet<string> = new Set(COIN_VALUE_ACTIONS.map((a) => `coins.${a}`));
/** What an acting session is refused: the coin commands plus `redemptions.resolve` (D-5, D-15 Q-2). */
const ACTING_DENIED: ReadonlySet<string> = new Set(ACTING_DENIED_ACTIONS);

/** What an operator admin of the tenant may do (also what an acting platform admin may do there). */
const ADMIN_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'tenant.read',
  'staff.invite',
  'staff.list',
  'players.read',
  'credentials.read',
  'credentials.rotate',
  'audit.read',
  'coins.adjust',
  'store.read',
  'store.manage',
  'redemptions.read',
  'redemptions.resolve',
  'rules.manage',
  'wheel.manage',
  'balance.read',
  'billing.manage',
  'usage.read',
]);
const STAFF_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'staff.list',
  'players.read',
  'store.read',
  'redemptions.read',
  'balance.read',
  'usage.read',
]);
/** What a player may do in their own tenant; the `own` ones are about the player's own records. */
const PLAYER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'spins.play',
  'store.read',
  'redemptions.create',
  'redemptions.read_own',
  'balance.read_own',
]);

@Injectable()
export class AccessService {
  constructor(private readonly audit: AuditService) {}

  /** Pure, default deny. The permission matrix is in spec section 3 and pinned by INV-RBAC-1. */
  can(subject: Subject, action: Action, object: ObjectRef): boolean {
    if (!(ACTIONS as readonly string[]).includes(action)) return false;
    if (!subject.tenantId || !object?.tenant_id) return false;
    if (COIN_VALUE.has(action)) return false; // value actions belong to services (D-1), never to a role
    const roles = subject.roles ?? [];

    if (roles.includes('platform_admin')) {
      if (subject.tenantId !== PLATFORM_TENANT_ID) return false;
      if (subject.acting) {
        // acting: operator-admin rights, in the acting tenant only
        if (object.tenant_id !== subject.acting.tenantId) return false;
        return ADMIN_ACTIONS.has(action) && !ACTING_DENIED.has(action);
      }
      if (action === 'acting.start' || action === 'tenant.suspend') return true;
      if (action === 'tenant.read') return object.tenant_id === PLATFORM_TENANT_ID;
      return false;
    }

    if (object.tenant_id !== subject.tenantId) return false;
    if (roles.includes('operator_admin') && ADMIN_ACTIONS.has(action)) return true;
    if (roles.includes('operator_staff') && STAFF_ACTIONS.has(action)) return true;
    if (roles.includes('player') && PLAYER_ACTIONS.has(action)) {
      // a record of another player is never reachable, whatever the action
      return object.user_id === undefined || object.user_id === subject.userId;
    }
    if (roles.includes('player') && action === 'player.self.read') {
      return object.user_id !== undefined && object.user_id === subject.userId;
    }
    return false;
  }

  /**
   * `can`, with the answers a caller may see: 404 for what it must not know exists, 403 for what
   * it may not do. A permitted acting request writes one audit row naming both identities.
   */
  async authorize(subject: Subject, action: Action, object: ObjectRef): Promise<void> {
    const isPlatformAdmin =
      (subject.roles ?? []).includes('platform_admin') && subject.tenantId === PLATFORM_TENANT_ID;
    const acting = isPlatformAdmin ? subject.acting : undefined;

    // D-26 INV-AUD: every refusal below is an AuthorizationRefused, so the entry point audits it `refused`.
    if (acting && ACTING_DENIED.has(action))
      throw new AuthorizationRefused({ code: 'ACTING_FORBIDDEN' });
    if (acting && action === 'acting.start')
      throw new AuthorizationRefused({ code: 'ACTING_FORBIDDEN' });

    if (isPlatformAdmin && !acting) {
      const operatorObject = object?.tenant_id !== PLATFORM_TENANT_ID;
      if (operatorObject && action !== 'tenant.suspend' && action !== 'acting.start') {
        if (!COIN_VALUE.has(action)) throw new AuthorizationRefused({ code: 'ACTING_REQUIRED' });
      }
    }
    if (acting && object?.tenant_id !== acting.tenantId) {
      throw new AuthorizationRefused({ code: 'ACTING_TENANT_MISMATCH' });
    }
    if (!isPlatformAdmin) {
      if (!object?.tenant_id || object.tenant_id !== subject.tenantId) {
        throw new AuthorizationRefused({ code: 'NOT_FOUND', status: 404 });
      }
      if (action === 'player.self.read' && (subject.roles ?? []).includes('player')) {
        if (object.user_id !== subject.userId) {
          throw new AuthorizationRefused({ code: 'NOT_FOUND', status: 404 });
        }
      }
    }
    if (
      !this.can({ ...subject, ...(acting ? { acting } : { acting: undefined }) }, action, object)
    ) {
      throw new AuthorizationRefused({ code: 'FORBIDDEN' });
    }
    if (acting) {
      await this.audit.record({
        tenantId: acting.tenantId,
        actorUserId: subject.userId,
        actorTenantId: subject.tenantId,
        actingTenantId: acting.tenantId,
        action,
        reason: acting.reason,
      });
    }
  }
}
