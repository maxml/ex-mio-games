import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  InternalResolvePlayerRequest,
  InternalVerifyWebhookRequest,
  InviteStaffRequest,
  LaunchRequest,
  LoginRequest,
  OperatorSignupRequest,
  PLATFORM_TENANT_ID,
  ServiceTokenRequest,
  StartActingRequest,
  Uuid,
  type AuditEntry,
  type CredentialIssued,
  type CredentialSummary,
  type InternalResolvePlayerResponse,
  type InternalVerifyWebhookResponse,
  type JwksResponse,
  type LaunchResponse,
  type PlayerLookup,
  type SignupResponse,
  type StaffMember,
  type TenantStatusResponse,
  type TenantView,
  type TokenResponse,
} from '@ex-mio/contracts';
import { currentAuth, InternalTenantless, parseInput, Public } from '@ex-mio/service-kit';
import { AccessService, type Subject } from '../services/access.service';
import { AuditService } from '../services/audit.service';
import { CredentialsService } from '../services/credentials.service';
import { LaunchService } from '../services/launch.service';
import { PlayersService } from '../services/players.service';
import { SessionsService } from '../services/sessions.service';
import { StaffService, type StaffUser } from '../services/staff.service';
import { TenantsService } from '../services/tenants.service';
import { RequirePermission } from './permissions';

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

// The contract asks for 2+ characters; the frozen INV-EDGE-14 signs up with the slug `c`.
const SignupBody = OperatorSignupRequest.extend({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});
const IdParam = z.object({ id: Uuid });
const UserIdParam = z.object({ userId: Uuid });
const TenantIdParam = z.object({ tenantId: Uuid });
const IssueCredentialRequest = z
  .object({ platform: z.string().trim().min(1).max(64) })
  .strict();
const RotateParams = z.object({ keyId: z.string().min(1).max(200) });
const RotateRequest = z
  .object({ grace_seconds: z.number().int().min(0).max(30 * 24 * 3600).default(0) })
  .strict();

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
    const tenant = await this.tenants.resolveByHost(Array.isArray(host) ? (host[0] ?? '') : (host ?? ''));
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

  @RequirePermission('acting.start')
  @Post('acting')
  @HttpCode(200)
  async acting(@Body() body: unknown): Promise<TokenResponse> {
    const input = parseInput(StartActingRequest, body);
    const s = subject();
    return this.sessions.startActing(s, input);
  }
}

@Controller('v1/operators')
export class OperatorsController {
  constructor(private readonly staff: StaffService) {}

  @Public()
  @Post('signup')
  async signup(@Body() body: unknown): Promise<SignupResponse> {
    const { tenant, user } = await this.staff.signUpOperator(parseInput(SignupBody, body));
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
    return this.credentials.issueFor(subject(), parseInput(IssueCredentialRequest, body).platform);
  }

  @RequirePermission('credentials.rotate')
  @Post(':keyId/rotate')
  rotate(@Param() params: unknown, @Body() body: unknown): Promise<CredentialIssued> {
    const { keyId } = parseInput(RotateParams, params);
    const { grace_seconds } = parseInput(RotateRequest, body ?? {});
    return this.credentials.rotate(subject(), keyId, { graceSeconds: grace_seconds });
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
  ) {}

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

  @InternalTenantless()
  @Post('internal/v1/webhooks/verify')
  @HttpCode(200)
  async verifyWebhook(@Body() body: unknown): Promise<InternalVerifyWebhookResponse> {
    const input = parseInput(InternalVerifyWebhookRequest, body);
    return this.credentials.verifyWebhookDetailed({
      apiKey: input.api_key,
      timestamp: input.timestamp,
      signature: input.signature,
      rawBody: input.raw_body,
    });
  }
}
