// The web BFF: the only thing that talks to the services. The browser calls `/api/...` with one HttpOnly
// session cookie (D-10); this module turns each call into the reconciled service calls (contracts
// reconciliation §2.4, W-1 ... W-14), keeps every token server-side and answers with the web read models.
//
// Where a service endpoint does not exist yet, the BFF answers with the mock engine's default for that
// field only and the browser adapter keeps the mock for that call (docs/submission/known-gaps.md).
import {
  ActAsTenantRequest,
  AuditEntry,
  BillingPlan,
  CredentialIssued,
  HEADER_IDEMPOTENCY_KEY,
  Invoice,
  LaunchResponse,
  MySpinsResponse,
  PaymentAttempt,
  PublicWheel,
  Redemption,
  RedeemRequest,
  SignupResponse,
  SpinResponse,
  StartActingRequest,
  StoreItem,
  Subscription,
  TokenResponse,
  UsageReport,
  WalletBalance,
  type AdminOverview,
  type OperatorState,
  type PlayerState,
} from '../../types';
import { WHEEL_REWARDS } from '../mio/engine/data';
import { createMockApi } from '../mio/mock';
import { createStore } from '../mio/engine/store';
import { emitWebEvent, stdoutProductEvents, type ProductEventSink } from './analytics';
import type { BffConfig } from './config';
import {
  mapAttempt,
  mapAudit,
  mapInvoice,
  mapItem,
  mapPlan,
  mapRedemption,
  mapSpin,
  mapUsage,
} from './mappers';
import {
  bearerFor,
  clearedSessionCookie,
  peekClaims,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  type ServiceAudience,
  type Session,
  type SessionStore,
} from './session';
import { BffError, createUpstream, listOf, type Upstream } from './upstream';

export interface BffDeps {
  config: BffConfig;
  sessions: SessionStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where product events go: one JSON line on stdout by default (docs/analytics.md). */
  productEvents?: ProductEventSink;
}

interface Ctx {
  request: Request;
  params: string[];
  body: Record<string, unknown>;
  session: Session | null;
  /** Cookie to set on the answer (a new session). */
  setCookie?: string;
}

type Handler = (ctx: Ctx) => Promise<{ status?: number; body?: unknown }>;

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

const str = (v: unknown, field: string, max = 500): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max)
    throw new BffError(422, 'validation_error', `${field} is required`);
  return v;
};

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'operator';

const AUDIENCES: ServiceAudience[] = ['identity', 'engagement', 'payments'];

export function createBff(deps: BffDeps) {
  const { config, sessions } = deps;
  const now = deps.now ?? Date.now;
  const up: Upstream = createUpstream(config, deps.fetch);
  const productEvents = deps.productEvents ?? stdoutProductEvents;

  const need = (s: Session | null): Session => {
    if (!s) throw new BffError(401, 'unauthenticated', 'Sign in first');
    return s;
  };
  const token = (s: Session, aud: ServiceAudience): string => {
    const t = bearerFor(s, aud, now());
    if (!t) throw new BffError(401, 'session_expired', 'The session has expired, sign in again');
    return t;
  };
  const idemKey = (ctx: Ctx): Record<string, string> => {
    const k = ctx.request.headers.get(HEADER_IDEMPOTENCY_KEY);
    if (!k) throw new BffError(400, 'idempotency_key_required', 'Idempotency-Key is required');
    return { [HEADER_IDEMPOTENCY_KEY]: k };
  };
  const hostHeader = (ctx: Ctx): Record<string, string> => {
    const host = ctx.request.headers.get('x-forwarded-host') ?? ctx.request.headers.get('host');
    // Identity resolves the tenant from the `Host` header only (`<slug>.<BASE_DOMAIN>`), so the browser's host
    // is passed as `Host`; `x-forwarded-host` stays for any hop that reads it.
    return host ? { host, 'x-forwarded-host': host } : {};
  };

  /** Hold the tokens of one login/launch exchange. Never returned to the browser. */
  const held = (r: { access_token: string; expires_in: number }) => ({
    token: r.access_token,
    expiresAt: now() + r.expires_in * 1000,
  });

  async function loginOperator(ctx: Ctx, email: string, password: string): Promise<Session> {
    const results = await Promise.all(
      AUDIENCES.map((audience) =>
        up('identity', 'POST', '/v1/auth/login', {
          body: { email, password, audience },
          headers: hostHeader(ctx),
          schema: TokenResponse,
        }),
      ),
    );
    const claims = peekClaims(results[0]!.access_token);
    const session = sessions.create({
      kind: 'operator',
      tenantId: claims.tid,
      userId: claims.sub,
      roles: claims.roles,
      tokens: Object.fromEntries(AUDIENCES.map((a, i) => [a, held(results[i]!)])),
      acting: null,
      attemptId: null,
      lastSpin: null,
      casinoDown: false,
    });
    ctx.setCookie = sessionCookie(session.id, config.secureCookie);
    return session;
  }

  // ---- state helpers ---------------------------------------------------------------------------

  const itemsOf = (s: Session) =>
    up('engagement', 'GET', '/v1/store/items', {
      token: token(s, 'engagement'),
      schema: listOf(StoreItem),
    });

  // ---- routes ----------------------------------------------------------------------------------

  const routes: Array<[string, RegExp, Handler]> = [
    // -- session
    [
      'POST',
      /^\/api\/session\/login$/,
      async (ctx) => {
        const s = await loginOperator(
          ctx,
          str(ctx.body.email, 'email', 254),
          str(ctx.body.password, 'password', 200),
        );
        return { body: { kind: s.kind, roles: s.roles, tenantId: s.tenantId } };
      },
    ],
    [
      'POST',
      /^\/api\/session\/launch$/,
      async (ctx) => {
        const launchToken = str(ctx.body.token, 'token', 4096);
        // A launch token is single-use (jti): one exchange per audience is asked, and a refusal of the second
        // one leaves that audience without a token (known-gaps G-8).
        const audiences: ServiceAudience[] = ['engagement', 'payments'];
        const tokens: Session['tokens'] = {};
        let first: { user_id: string; tenant_id: string } | null = null;
        for (const audience of audiences) {
          try {
            const r = await up('identity', 'POST', '/v1/auth/launch', {
              body: { token: launchToken, audience },
              schema: LaunchResponse,
            });
            tokens[audience] = held(r);
            first ??= r;
          } catch (e) {
            if (!first) throw e;
          }
        }
        if (!first) throw new BffError(401, 'LAUNCH_TOKEN_INVALID');
        const session = sessions.create({
          kind: 'player',
          tenantId: first.tenant_id,
          userId: first.user_id,
          roles: ['player'],
          tokens,
          acting: null,
          attemptId: null,
          lastSpin: null,
          casinoDown: false,
        });
        ctx.setCookie = sessionCookie(session.id, config.secureCookie);
        return { body: { kind: 'player' } };
      },
    ],
    // Product analytics: the widget was opened. Only a player session (verified player and tenant) is
    // written; before a launch nothing names a verified tenant, so nothing is written (INV-WEB-AN-1).
    [
      'POST',
      /^\/api\/widget\/opened$/,
      async (ctx) => {
        const s = ctx.session;
        if (s && s.kind === 'player') {
          emitWebEvent(productEvents, {
            event: 'web.widget_opened',
            tenant_id: s.tenantId,
            actor_type: 'player',
            actor_id: s.userId,
            props: { launched: true },
          });
          return { status: 204 };
        }
        // INV-WEB-AN-1: no verified identity, no tenant. A launch token's `kid` or any body claim is
        // unverified input and never names the tenant of a line, so nothing is written.
        return { status: 204 };
      },
    ],
    [
      'POST',
      /^\/api\/session\/logout$/,
      async (ctx) => {
        sessions.destroy(ctx.session?.id);
        ctx.setCookie = clearedSessionCookie(config.secureCookie);
        return { status: 204 };
      },
    ],
    // D-10: the realtime ticket is fetched through the BFF with the cookie; the browser never holds the
    // long-lived token. Identity issues it (`aud=realtime`, <= 60 s). Known-gaps G-9: no service route yet.
    [
      'GET',
      /^\/api\/realtime\/ticket$/,
      async (ctx) => {
        const s = need(ctx.session);
        const r = await up<{ ticket: string; expires_in: number }>(
          'identity',
          'POST',
          '/v1/auth/realtime-ticket',
          {
            token: token(s, s.tokens.identity ? 'identity' : 'engagement'),
            body: {},
          },
        );
        if (typeof r?.ticket !== 'string')
          throw new BffError(
            502,
            'bad_upstream_response',
            'identity answered with an unexpected shape',
          );
        return { body: { ticket: r.ticket, expiresIn: r.expires_in } };
      },
    ],

    // -- player
    [
      'GET',
      /^\/api\/player\/state$/,
      async (ctx) => {
        const s = need(ctx.session);
        const [balance, spins, items, redemptions, wheel] = await Promise.all([
          // W-3: the balance comes from payments (`available`), eventually consistent (D-1).
          up('payments', 'GET', '/v1/me/balance', {
            token: token(s, 'payments'),
            schema: WalletBalance,
          }),
          // `GET /v1/me/spins`
          up('engagement', 'GET', '/v1/me/spins', {
            token: token(s, 'engagement'),
            schema: MySpinsResponse,
          }),
          itemsOf(s),
          up('engagement', 'GET', '/v1/me/redemptions', {
            token: token(s, 'engagement'),
            schema: listOf(Redemption),
          }),
          config.wheelId
            ? up('engagement', 'GET', `/v1/wheel/${encodeURIComponent(config.wheelId)}`, {
                token: token(s, 'engagement'),
                schema: PublicWheel,
              })
            : Promise.resolve(null),
        ]);
        const byId = new Map(items.map((i) => [i.id, i]));
        const state: PlayerState = {
          coins: balance.available,
          spins: spins.available,
          // W-2 / G-3: with no configured wheel id the default wheel labels are used (no service names the
          // active wheel). The segment id is its index.
          wheel: wheel
            ? wheel.segments.map((seg, i) => ({ id: String(i), label: seg.label }))
            : WHEEL_REWARDS.map((r) => ({ id: r.id, label: r.label })),
          store: items.filter((i) => i.active).map(mapItem),
          // W-4 / G-1: no ledger-history endpoint (`/v1/me/transactions`). The browser adapter overlays the mock's.
          history: [],
          redemptions: redemptions.map((r) => mapRedemption(r, byId)),
          lastSpin: s.lastSpin,
          casinoDown: s.casinoDown,
        };
        return { body: state };
      },
    ],
    [
      'POST',
      /^\/api\/player\/spins$/,
      async (ctx) => {
        const s = need(ctx.session);
        const spin = await up('engagement', 'POST', '/v1/spins', {
          token: token(s, 'engagement'),
          body: {},
          headers: idemKey(ctx),
          schema: SpinResponse,
        });
        s.lastSpin = mapSpin(spin);
        return { status: 201, body: s.lastSpin };
      },
    ],
    [
      'POST',
      /^\/api\/player\/redemptions$/,
      async (ctx) => {
        const s = need(ctx.session);
        const req = RedeemRequest.safeParse(ctx.body);
        if (!req.success) throw new BffError(422, 'validation_error', 'itemId is required');
        // 202. A 409 `insufficient_funds|out_of_stock|limit_reached|item_inactive|idempotency_in_progress|
        // illegal_transition` goes through with its code; the browser tells retry from refusal.
        const [red, items] = await Promise.all([
          up('engagement', 'POST', '/v1/redemptions', {
            token: token(s, 'engagement'),
            body: { item_id: req.data.itemId },
            headers: idemKey(ctx),
            schema: Redemption,
          }),
          itemsOf(s).catch(() => [] as StoreItem[]),
        ]);
        return { status: 202, body: mapRedemption(red, new Map(items.map((i) => [i.id, i]))) };
      },
    ],
    [
      'POST',
      /^\/api\/sandbox\/deposits$/,
      async (ctx) => {
        need(ctx.session);
        const eur = Number(ctx.body.eur ?? 40);
        if (!Number.isFinite(eur) || eur <= 0 || eur > 100_000)
          throw new BffError(422, 'validation_error', 'eur must be a positive amount');
        if (!config.sandboxTargetUrl || !config.sandboxSecret || !config.sandboxPlayerId)
          throw new BffError(501, 'service_not_configured', 'The sandbox casino is not configured');
        // W-8: casino-sim -> ingest -> consumer -> `spin.granted` is asynchronous: answer "accepted", the widget refetches.
        await up('casino-sim', 'POST', `/${config.casinoPath}/__deposit`, {
          body: {
            target_url: config.sandboxTargetUrl,
            secret: config.sandboxSecret,
            player_id: config.sandboxPlayerId,
            amount_minor: Math.round(eur * 100),
            currency: 'EUR',
            event_id: globalThis.crypto.randomUUID(),
          },
        });
        return { body: { accepted: true } };
      },
    ],
    [
      'POST',
      /^\/api\/sandbox\/casino-down$/,
      async (ctx) => {
        const s = need(ctx.session);
        const on = ctx.body.on === true;
        await up('casino-sim', 'POST', '/__faults', {
          body: {
            casino: config.casinoPath.endsWith('b') ? 'b' : 'a',
            kind: 'error',
            times: on ? 1000 : 0,
          },
        });
        s.casinoDown = on;
        return { status: 204 };
      },
    ],

    // -- operator
    [
      'GET',
      /^\/api\/operator\/state$/,
      async (ctx) => {
        const s = need(ctx.session);
        const pay = token(s, 'payments');
        const eng = token(s, 'engagement');
        const [plans, sub, invoices, usage, items, redemptions, attempt] = await Promise.all([
          up('payments', 'GET', '/v1/billing/plans', { token: pay, schema: listOf(BillingPlan) }),
          up('payments', 'GET', '/v1/billing/subscription', {
            token: pay,
            schema: Subscription,
            nullOn404: true,
          }),
          up('payments', 'GET', '/v1/billing/invoices', { token: pay, schema: listOf(Invoice) }),
          // Payments requires `?period=YYYY-MM`; the console shows the current (UTC) month.
          up(
            'payments',
            'GET',
            `/v1/billing/usage?period=${new Date(now()).toISOString().slice(0, 7)}`,
            {
              token: pay,
              schema: UsageReport,
              nullOn404: true,
            },
          ),
          up('engagement', 'GET', '/v1/store/items', { token: eng, schema: listOf(StoreItem) }),
          up('engagement', 'GET', '/v1/operator/redemptions', {
            token: eng,
            schema: listOf(Redemption),
          }),
          s.attemptId
            ? up('payments', 'GET', `/v1/billing/attempts/${encodeURIComponent(s.attemptId)}`, {
                token: pay,
                schema: PaymentAttempt,
                nullOn404: true,
              })
            : Promise.resolve(null),
        ]);
        const byUuid = new Map(plans.map((p) => [p.id, p]));
        const byId = new Map(items.map((i) => [i.id, i]));
        const active = sub?.status === 'active' ? byUuid.get(sub.plan_id) : undefined;
        const invoice = mapInvoice(invoices[0], byUuid.get(sub?.plan_id ?? ''));
        // Fields with no service source (rules, wheel, sandbox, go-live, step progress) come from the mock
        // engine's defaults; the browser adapter keeps its own mock for those and overlays only the fields below.
        const base: OperatorState = await createMockApi({
          store: createStore(),
        }).operator.getState();
        const state: OperatorState = {
          ...base,
          accountCreated: true,
          plans: plans.map(mapPlan),
          planActive: active !== undefined,
          invoicePaid: invoice?.paid ?? false,
          payment: attempt ? mapAttempt(attempt, byUuid) : null,
          cardLast4: attempt?.card_last4 ?? null,
          paidPlan: active?.code ?? null,
          paidAmount: active ? Math.round(active.price_minor) / 100 : null,
          catalog: items.map((i) => ({ ...mapItem(i), visible: i.active })),
          redemptions: redemptions.map((r) => ({
            id: r.id,
            player: 'player',
            item: byId.get(r.item_id)?.name ?? 'Item',
            coins: r.price,
            status: r.status,
            at: r.updated_at,
          })),
          usage: usage ? mapUsage(usage) : base.usage,
          invoice: invoice ?? base.invoice,
        };
        return { body: state };
      },
    ],
    [
      'POST',
      /^\/api\/operator\/account$/,
      async (ctx) => {
        // W-11: the console's company name, e-mail and password go to L1's signup; then the session is opened.
        const companyName = str(ctx.body.companyName, 'companyName', 120);
        const email = str(ctx.body.email, 'email', 254);
        const password = str(ctx.body.password, 'password', 200);
        await up('identity', 'POST', '/v1/operators/signup', {
          body: {
            tenant_name: companyName,
            slug:
              typeof ctx.body.slug === 'string' && ctx.body.slug
                ? ctx.body.slug
                : slugify(companyName),
            email,
            password,
          },
          schema: SignupResponse,
        });
        await loginOperator(ctx, email, password);
        return { status: 201 };
      },
    ],
    // Casino integration credentials: `POST /v1/credentials` (identity). Both the platform and the environment
    // are required by the service. The secrets are returned once and never stored by the BFF.
    [
      'POST',
      /^\/api\/operator\/credentials$/,
      async (ctx) => {
        const s = need(ctx.session);
        const environment = ctx.body.environment;
        if (environment !== 'sandbox' && environment !== 'production')
          throw new BffError(422, 'validation_error', 'environment must be sandbox or production');
        const issued = await up('identity', 'POST', '/v1/credentials', {
          token: token(s, 'identity'),
          body: { platform: config.casinoPath, environment },
          schema: CredentialIssued,
        });
        return {
          status: 201,
          body: {
            environment,
            keyId: issued.key_id,
            apiKey: issued.api_key,
            hmacSecret: issued.hmac_secret,
          },
        };
      },
    ],
    // Rules: `PUT /v1/operator/rules` (engagement). `min` is EUR, the service takes minor units. `cap` is the
    // per-player grant limit. `per` ("per each N EUR") has no service field and is dropped (known-gaps G-4).
    [
      'POST',
      /^\/api\/operator\/rules$/,
      async (ctx) => {
        const s = need(ctx.session);
        const num = (v: unknown, name: string): number => {
          if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)
            throw new BffError(422, 'validation_error', `${name} must be a positive integer`);
          return v;
        };
        const min = num(ctx.body.min, 'min');
        await up('engagement', 'PUT', '/v1/operator/rules', {
          token: token(s, 'engagement'),
          body: {
            name: 'Deposit rule',
            min_amount_minor: min * 100,
            currency: 'EUR',
            spins: num(ctx.body.spins, 'spins'),
            max_grants_per_player: num(ctx.body.cap, 'cap'),
          },
        });
        return { status: 204 };
      },
    ],
    // Wheel: `PUT /v1/operator/wheel`. The console edits the weights of its fixed eight coin segments; the
    // service takes integer weights, so the (up to one decimal) console weights are sent times 10.
    [
      'POST',
      /^\/api\/operator\/wheel\/publish$/,
      async (ctx) => {
        const s = need(ctx.session);
        const w = ctx.body.weights;
        if (
          !Array.isArray(w) ||
          w.length !== WHEEL_REWARDS.length ||
          !w.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)
        )
          throw new BffError(
            422,
            'validation_error',
            'weights must be one positive number per segment',
          );
        await up('engagement', 'PUT', '/v1/operator/wheel', {
          token: token(s, 'engagement'),
          body: {
            name: 'Daily Wheel',
            segments: WHEEL_REWARDS.map((r, i) => ({
              label: r.label,
              weight: Math.max(1, Math.round((w[i] as number) * 10)),
              reward: { type: 'coins', amount: r.coins },
            })),
          },
        });
        return { status: 204 };
      },
    ],
    [
      'POST',
      /^\/api\/operator\/payments$/,
      async (ctx) => {
        const s = need(ctx.session);
        const pay = token(s, 'payments');
        const code = str(ctx.body.planId, 'planId', 64);
        const card = str(ctx.body.cardNumber, 'cardNumber', 19);
        const plans = await up('payments', 'GET', '/v1/billing/plans', {
          token: pay,
          schema: listOf(BillingPlan),
        });
        const plan = plans.find((p) => p.code === code || p.id === code);
        if (!plan) throw new BffError(404, 'plan_not_found', 'Unknown plan');
        // W-9: the full test card number goes to L2 (it keeps only last4 + brand); L2 hashes the request without it.
        const attempt = await up('payments', 'POST', '/v1/billing/attempts', {
          token: pay,
          body: { plan_id: plan.id, card_number: card.replace(/\D/g, '') },
          headers: idemKey(ctx),
          schema: PaymentAttempt,
        });
        s.attemptId = attempt.id;
        return { status: 201, body: mapAttempt(attempt, new Map(plans.map((p) => [p.id, p]))) };
      },
    ],
    [
      'POST',
      /^\/api\/operator\/payments\/([^/]+)\/cancel$/,
      async (ctx) => {
        const s = need(ctx.session);
        // W-9: cancel REQUIRES an Idempotency-Key (L2), so the browser sends one and the BFF forwards it.
        await up(
          'payments',
          'POST',
          `/v1/billing/attempts/${encodeURIComponent(ctx.params[0]!)}/cancel`,
          {
            token: token(s, 'payments'),
            body: {},
            headers: idemKey(ctx),
          },
        );
        return { status: 204 };
      },
    ],
    [
      'POST',
      /^\/api\/operator\/catalog\/([^/]+)\/price$/,
      async (ctx) => {
        const s = need(ctx.session);
        const price = Number(ctx.body.priceCoins);
        await up('engagement', 'PATCH', `/v1/store/items/${encodeURIComponent(ctx.params[0]!)}`, {
          token: token(s, 'engagement'),
          body: { price },
        });
        return { status: 204 };
      },
    ],
    [
      'POST',
      /^\/api\/operator\/catalog\/([^/]+)\/visibility$/,
      async (ctx) => {
        const s = need(ctx.session);
        await up('engagement', 'PATCH', `/v1/store/items/${encodeURIComponent(ctx.params[0]!)}`, {
          token: token(s, 'engagement'),
          body: { active: ctx.body.visible === true },
        });
        return { status: 204 };
      },
    ],

    // -- platform admin
    [
      'GET',
      /^\/api\/platform\/overview$/,
      async (ctx) => {
        const s = need(ctx.session);
        const audit = await up('identity', 'GET', '/v1/audit', {
          token: token(s, 'identity'),
          schema: listOf(AuditEntry),
        });
        // W-13 / G-2: no platform read for plan, MRR, spins, depositors: the tenant table and the funnel are
        // the browser's mock; only the audit trail is real.
        const overview: AdminOverview = { tenants: [], funnel: [], audit: mapAudit(audit) };
        return { body: overview };
      },
    ],
    [
      'POST',
      /^\/api\/platform\/act-as$/,
      async (ctx) => {
        const s = need(ctx.session);
        const req = ActAsTenantRequest.safeParse(ctx.body);
        if (!req.success)
          throw new BffError(
            422,
            'validation_error',
            'A reason of at least 8 characters is required',
          );
        // W-12: L1's body is snake_case. One acting token per audience (a token is valid for one service); they
        // stay in the session, never in the answer.
        const own = token({ ...s, acting: null }, 'identity');
        const tokens: Session['tokens'] = {};
        for (const audience of AUDIENCES) {
          const body = StartActingRequest.safeParse({
            tenant_id: req.data.tenantId,
            reason: req.data.reason,
            audience,
          });
          if (!body.success)
            throw new BffError(422, 'validation_error', 'tenantId must be a tenant id');
          tokens[audience] = held(
            await up('identity', 'POST', '/v1/auth/acting', {
              token: own,
              body: body.data,
              schema: TokenResponse,
            }),
          );
        }
        s.acting = { tenantId: req.data.tenantId, tokens };
        return { status: 204 };
      },
    ],
  ];

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const route = routes.find(([m, re]) => m === method && re.test(url.pathname));
    if (!route) return json(404, { message: 'Not found', code: 'not_found' });
    const [, re, handler] = route;
    const sid = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    const raw = method === 'GET' ? undefined : await request.json().catch(() => undefined);
    const ctx: Ctx = {
      request,
      params: (url.pathname.match(re) ?? []).slice(1),
      body: typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {},
      session: sessions.get(sid),
    };
    try {
      const out = await handler(ctx);
      return json(
        out.status ?? 200,
        out.body,
        ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {},
      );
    } catch (e) {
      if (e instanceof BffError) return json(e.status, { message: e.message, code: e.code });
      return json(500, { message: 'Internal error', code: 'internal' });
    }
  }

  return { handle };
}
