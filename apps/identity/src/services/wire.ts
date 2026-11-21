import type { ServiceName } from '@ex-mio/contracts';
import type { Clock, Repos, UnitOfWork } from '../model/ports';
import { AccessService } from './access.service';
import { AuditService } from './audit.service';
import { CredentialsService } from './credentials.service';
import type { IdentityProvider } from './identity-provider';
import { LaunchService } from './launch.service';
import { PlayersService } from './players.service';
import { SessionsService, type KeyGenerator } from './sessions.service';
import { StaffService } from './staff.service';
import { TenantsService } from './tenants.service';

export interface WireDeps {
  uow: UnitOfWork;
  repos: Repos;
  clock: Clock;
  provider: IdentityProvider;
  baseDomain: string;
  kek: string;
  serviceSecrets: Partial<Record<ServiceName, string>>;
  keyGenerator?: KeyGenerator;
}

export interface Services {
  tenants: TenantsService;
  audit: AuditService;
  access: AccessService;
  sessions: SessionsService;
  staff: StaffService;
  credentials: CredentialsService;
  players: PlayersService;
  launch: LaunchService;
}

/**
 * The one place the services are put together. The Nest module (production) and the test kernel
 * both call it, so the frozen tests run the same services the controllers use.
 */
export function wireServices(d: WireDeps): Services {
  const tenants = new TenantsService(d.uow, d.repos, d.provider, d.baseDomain);
  const audit = new AuditService(d.uow, d.repos, d.clock);
  const access = new AccessService(audit);
  const sessions = new SessionsService(d.uow, d.repos, d.clock, d.provider, tenants, audit, {
    kek: d.kek,
    serviceSecrets: d.serviceSecrets,
    ...(d.keyGenerator ? { keyGenerator: d.keyGenerator } : {}),
  });
  const staff = new StaffService(d.uow, d.repos, d.provider, tenants, access);
  const credentials = new CredentialsService(d.uow, d.repos, d.clock, access, d.kek);
  const players = new PlayersService(d.uow, d.repos, access);
  const launch = new LaunchService(d.uow, d.repos, d.clock, credentials, players, sessions, tenants, d.provider);
  return { tenants, audit, access, sessions, staff, credentials, players, launch };
}
