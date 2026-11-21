import type { Type } from '@nestjs/common';
import {
  AuditController,
  AuthController,
  CredentialsController,
  InternalController,
  JwksController,
  OperatorsController,
  PlayersController,
  StaffController,
  TenantsController,
} from './identity.controllers';

export { IdentityExceptionFilter } from './identity-exception.filter';
export {
  PermissionGuard,
  PermissionGuardModule,
  PERMISSION_KEY,
  RequirePermission,
} from './permissions';

/** Every controller identity serves. A route scan (INV-PERM, INV-S2S-6) walks exactly this list. */
export const identityControllers: Type[] = [
  AuthController,
  OperatorsController,
  StaffController,
  PlayersController,
  TenantsController,
  CredentialsController,
  AuditController,
  JwksController,
  InternalController,
];
