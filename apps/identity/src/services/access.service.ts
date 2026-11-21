import { Injectable } from '@nestjs/common';
import {
  ACTIONS,
  COIN_VALUE_ACTIONS,
  PLATFORM_TENANT_ID,
  type AccessTokenClaims,
  type Action,
  type Role,
} from '@ex-mio/contracts';
import { IdentityError } from '../errors';
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

const COIN_VALUE: ReadonlySet<string> = new Set(COIN_VALUE_ACTIONS);

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
]);
const STAFF_ACTIONS: ReadonlySet<Action> = new Set<Action>(['staff.list', 'players.read']);

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
        return ADMIN_ACTIONS.has(action);
      }
      if (action === 'acting.start' || action === 'tenant.suspend') return true;
      if (action === 'tenant.read') return object.tenant_id === PLATFORM_TENANT_ID;
      return false;
    }

    if (object.tenant_id !== subject.tenantId) return false;
    if (roles.includes('operator_admin') && ADMIN_ACTIONS.has(action)) return true;
    if (roles.includes('operator_staff') && STAFF_ACTIONS.has(action)) return true;
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

    if (acting && COIN_VALUE.has(action)) throw new IdentityError('ACTING_FORBIDDEN');
    if (acting && action === 'acting.start') throw new IdentityError('ACTING_FORBIDDEN');

    if (isPlatformAdmin && !acting) {
      const operatorObject = object?.tenant_id !== PLATFORM_TENANT_ID;
      if (operatorObject && action !== 'tenant.suspend' && action !== 'acting.start') {
        if (!COIN_VALUE.has(action)) throw new IdentityError('ACTING_REQUIRED');
      }
    }
    if (acting && object?.tenant_id !== acting.tenantId) {
      throw new IdentityError('ACTING_TENANT_MISMATCH');
    }
    if (!isPlatformAdmin) {
      if (!object?.tenant_id || object.tenant_id !== subject.tenantId) {
        throw new IdentityError('NOT_FOUND');
      }
      if (action === 'player.self.read' && (subject.roles ?? []).includes('player')) {
        if (object.user_id !== subject.userId) throw new IdentityError('NOT_FOUND');
      }
    }
    if (!this.can({ ...subject, ...(acting ? { acting } : { acting: undefined }) }, action, object)) {
      throw new IdentityError('FORBIDDEN');
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
