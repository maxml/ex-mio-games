import type { Provider } from '@nestjs/common';
import { AccessService } from './access.service';
import { AuditService } from './audit.service';
import { CredentialsService } from './credentials.service';
import { LaunchService } from './launch.service';
import { PlayersService } from './players.service';
import { SessionsService } from './sessions.service';
import { StaffService } from './staff.service';
import { TenantsService } from './tenants.service';
import type { Services } from './wire';

/** Nest providers for the wired services: controllers inject the classes, the instances come from `wireServices`. */
export const serviceProviders = (s: Services): Provider[] => [
  { provide: TenantsService, useValue: s.tenants },
  { provide: AuditService, useValue: s.audit },
  { provide: AccessService, useValue: s.access },
  { provide: SessionsService, useValue: s.sessions },
  { provide: StaffService, useValue: s.staff },
  { provide: CredentialsService, useValue: s.credentials },
  { provide: PlayersService, useValue: s.players },
  { provide: LaunchService, useValue: s.launch },
];
