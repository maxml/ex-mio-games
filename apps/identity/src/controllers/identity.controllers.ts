import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  CasinoParam,
  PutRewardApiRequest,
  type RewardApiSummary,
  InternalResolvePlayerRequest,
  InviteStaffRequest,
  IssueCredentialRequest,
  LaunchRequest,
  LoginRequest,
  OperatorSignupRequest,
  PLATFORM_TENANT_ID,
  RealtimeTicketRedeemRequest,
  RealtimeTicketRequest,
  RotateRequest,
  ServiceTokenRequest,
  StartActingRequest,
  Uuid,
  type AuditEntry,
  type CredentialIssued,
  type CredentialSummary,
  type InternalResolvePlayerResponse,
  type JwksResponse,
  type LaunchResponse,
  type PlayerLinkResponse,
  type PlayerLookup,
  type RealtimeTicketRedeemResponse,
  type RealtimeTicketResponse,
  type SignupResponse,
  type StaffMember,
  type TenantIntegration,
  type TenantStatusResponse,
  type TenantView,
  type TokenResponse,
} from '@ex-mio/contracts';
import { currentAuth, InternalTenantless, parseInput, Public } from '@ex-mio/service-kit';
import { IdentityError } from '../errors';
import { AccessService, type Subject } from '../services/access.service';
import { AuditService } from '../services/audit.service';
import { CredentialsService } from '../services/credentials.service';
import { LaunchService } from '../services/launch.service';
import { PlayersService } from '../services/players.service';
import { SessionsService } from '../services/sessions.service';
import { StaffService, type StaffUser } from '../services/staff.service';
import { TenantsService } from '../services/tenants.service';
import { AuthenticatedSelf, RequirePermission } from './permissions';

/** The caller as a Subject, from the auth context the entry point established (never a header). */
function subject(): Subject {
  const a = currentAuth();
  return {
    userId: a.principalId,
    tenantId: a.acting ? PLATFORM_TENANT_ID : (a.tenantId ?? ''),
    roles: a.roles,
    ...(a.acting ? { acting: a.acting } : {}),
  };
}

const toMember = (u: StaffUser): StaffMember => ({
  id: u.id,
  email: u.email,
  roles: u.roles as StaffMember['roles'],
});

const IdParam = z.object({ id: Uuid });
const UserIdParam = z.object({ userId: Uuid });
const TenantIdParam = z.object({ tenantId: Uuid });
const TenantUserParam = z.object({ tenantId: Uuid, userId: Uuid });
const SlugParam = z.object({ slug: z.string().trim().min(1).max(48) });
const CasinoParams = z.object({ casino: CasinoParam });
const RotateParams = z.object({ keyId: z.string().min(1).max(200) });

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly sessions: SessionsService,
    private readonly launch: LaunchService,
  ) {}

  /** The tenant comes from the Host only; the body cannot name one (`.strict()`). */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: { headers: Record<string, string | string[] | undefined> },
  ): Promise<TokenResponse> {
    const input = parseInput(LoginRequest, body);
    const host = req.headers['host'];
    const tenant = await this.tenants.resolveByHost(
      Array.isArray(host) ? (host[0] ?? '') : (host ?? ''),
    );
    return this.sessions.login(tenant.id, input);
  }

  @Public()
  @Post('launch')
  @HttpCode(200)
  launchExchange(@Body() body: unknown): Promise<LaunchResponse> {
    return this.launch.exchange(parseInput(LaunchRequest, body));
  }

  @Public()
  @Post('service-token')
  @HttpCode(200)
  serviceToken(@Body() body: unknown): TokenResponse {
    return this.sessions.issueServiceToken(parseInput(ServiceTokenRequest, body));
  }

  /** D-10, D-22: the caller's own session becomes a one-time socket ticket (aud realtime, <= 60 s). */
  @AuthenticatedSelf()
  @Post('realtime-ticket')
  @HttpCode(200)
  realtimeTicket(@Body() body: unknown): RealtimeTicketResponse {
    parseInput(RealtimeTicketRequest, body ?? {});
    return this.sessions.issueRealtimeTicket(subject(), currentAuth().sandbox);
  }

  @RequirePermission('acting.start')
  @Post('acting')
  @HttpCode(200)
  async acting(@Body() body: unknown): Promise<TokenResponse> {
    const s = subject();
    this.sessions.assertMayStartActing(s); // who may ask is decided before the body is looked at
    const input = parseInput(StartActingRequest, body);
    return this.sessions.startActing(s, input);
  }
}

@Controller('v1/operators')
export class OperatorsController {
  constructor(private readonly staff: StaffService) {}

  @Public()
  @Post('signup')
  async signup(@Body() body: unknown): Promise<SignupResponse> {
    const { tenant, user } = await this.staff.signUpOperator(
      parseInput(OperatorSignupRequest, body),
    );
    return { tenant, user: toMember(user) };
  }
}

@Controller('v1/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @RequirePermission('staff.invite')
  @Post()
  async invite(@Body() body: unknown): Promise<StaffMember> {
    return toMember(await this.staff.invite(subject(), parseInput(InviteStaffRequest, body)));
  }

  @RequirePermission('staff.list')
  @Get()
  async list(): Promise<StaffMember[]> {
    return (await this.staff.list(subject())).map(toMember);
  }
}

@Controller('v1/players')
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  @RequirePermission('players.read')
  @Get(':userId')
  lookup(@Param() params: unknown): Promise<PlayerLookup> {
    return this.players.lookup(subject(), parseInput(UserIdParam, params).userId);
  }
}

@Controller('v1/tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission('tenant.read')
  @Get(':id')
  async get(@Param() params: unknown): Promise<TenantView> {
    const { id } = parseInput(IdParam, params);
    await this.access.authorize(subject(), 'tenant.read', { tenant_id: id });
    return this.tenants.get(id);
  }

  @RequirePermission('tenant.suspend')
  @Post(':id/suspend')
  @HttpCode(200)
  async suspend(@Param() params: unknown): Promise<TenantView> {
    const { id } = parseInput(IdParam, params);
    await this.access.authorize(subject(), 'tenant.suspend', { tenant_id: id });
    return this.tenants.setStatus(id, 'suspended');
  }
}

@Controller('v1/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @RequirePermission('credentials.read')
  @Get()
  list(): Promise<CredentialSummary[]> {
    return this.credentials.list(subject());
  }

  @RequirePermission('credentials.rotate')
  @Post()
  issue(@Body() body: unknown): Promise<CredentialIssued> {
    const { platform, environment } = parseInput(IssueCredentialRequest, body);
    return this.credentials.issueFor(subject(), platform, environment);
  }

  @RequirePermission('credentials.rotate')
  @Post(':keyId/rotate')
  rotate(@Param() params: unknown, @Body() body: unknown): Promise<CredentialIssued> {
    const { keyId } = parseInput(RotateParams, params);
    const { grace_seconds } = parseInput(RotateRequest, body ?? {});
    return this.credentials.rotate(subject(), keyId, { graceSeconds: grace_seconds });
  }
}

/** D-27: the operator's own casino integration settings. */
@Controller('v1/operator/integrations')
export class OperatorIntegrationsController {
  constructor(private readonly credentials: CredentialsService) {}

  /** Where MIO calls the casino to issue a reward, and the secret that signs those calls. */
  @RequirePermission('credentials.rotate')
  @Put(':casino/reward-api')
  putRewardApi(@Param() params: unknown, @Body() body: unknown): Promise<RewardApiSummary> {
    const { casino } = parseInput(CasinoParams, params);
    return this.credentials.putRewardApi(subject(), casino, parseInput(PutRewardApiRequest, body));
  }
}

@Controller('v1/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission('audit.read')
  @Get()
  async list(): Promise<AuditEntry[]> {
    const s = subject();
    const tenantId = s.acting?.tenantId ?? s.tenantId;
    await this.access.authorize(s, 'audit.read', { tenant_id: tenantId });
    return this.audit.list(tenantId);
  }
}

@Controller('.well-known')
export class JwksController {
  constructor(private readonly sessions: SessionsService) {}

  @Public()
  @Get('jwks.json')
  async jwks(): Promise<JwksResponse> {
    await this.sessions.reload();
    return this.sessions.jwks();
  }
}

/** Service-token routes (D-4). The entry point set the tenant from the path; nothing is read from a header. */
// No controller prefix: each handler carries its full `internal/v1/...` path, so the route table
// reads exactly like INTERNAL_ROUTES in the contract.
@Controller()
export class InternalController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly players: PlayersService,
    private readonly credentials: CredentialsService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * D-23: the realtime gateway turns a one-time ticket into its principal. Tenant-less (the tenant
   * is the ticket's own `tid`); the entry point allow-lists the calling service.
   */
  @InternalTenantless()
  @Post('internal/v1/realtime-tickets/redeem')
  @HttpCode(200)
  redeemRealtimeTicket(@Body() body: unknown): Promise<RealtimeTicketRedeemResponse> {
    return this.sessions.redeemRealtimeTicket(parseInput(RealtimeTicketRedeemRequest, body).ticket);
  }

  @Get('internal/v1/tenants/:tenantId/status')
  status(@Param() params: unknown): Promise<TenantStatusResponse> {
    return this.tenants.status(parseInput(TenantIdParam, params).tenantId);
  }

  @Post('internal/v1/tenants/:tenantId/players/resolve')
  @HttpCode(200)
  resolve(@Param() params: unknown, @Body() body: unknown): Promise<InternalResolvePlayerResponse> {
    const { tenantId } = parseInput(TenantIdParam, params);
    const input = parseInput(InternalResolvePlayerRequest, body);
    return this.players.resolveOrCreate(tenantId, input.platform, input.external_player_id);
  }

  /** X-7: the casino integration of the path tenant (secrets, hash key, environment). */
  @Get('internal/v1/tenants/:tenantId/integration')
  integration(@Param() params: unknown): Promise<TenantIntegration> {
    return this.credentials.integration(parseInput(TenantIdParam, params).tenantId);
  }

  /** X-7: the one tenant-less internal route; the slug names the tenant. 404 when unknown. */
  @InternalTenantless()
  @Get('internal/v1/integrations/by-slug/:slug')
  async integrationBySlug(@Param() params: unknown): Promise<TenantIntegration> {
    const { slug } = parseInput(SlugParam, params);
    const found = await this.credentials.integrationBySlug(slug);
    if (!found) throw new IdentityError('NOT_FOUND', 'no integration');
    return found;
  }

  /** X-8: the reverse of resolve. 404 for another tenant's player or after the erasure. */
  @Get('internal/v1/tenants/:tenantId/players/:userId/link')
  playerLink(@Param() params: unknown): Promise<PlayerLinkResponse> {
    const { tenantId, userId } = parseInput(TenantUserParam, params);
    return this.players.linkOf(tenantId, userId);
  }
}
