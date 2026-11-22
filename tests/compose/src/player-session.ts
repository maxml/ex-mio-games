import { request } from 'node:http';
import { CredentialIssued, LaunchResponse } from '@ex-mio/contracts';
import { signLaunchToken } from '@ex-mio/service-kit/testing';
import { urls } from './env';

/*
 * Player sessions for the engagement compose tests (D-4, D-12): a player is a real launch through the
 * identity service (the casino signs a launch token with the key issued to the operator), and the
 * token that comes back is what the engagement HTTP API accepts. No `x-tenant-id` / `x-principal-id`
 * header exists anywhere. Every call to `newTenant()` makes a fresh operator, so a test owns its
 * tenant and nothing leaks between tests.
 */

interface Http {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const call = (
  method: 'GET' | 'POST',
  base: string,
  path: string,
  opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Http> =>
  new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body ? JSON.stringify(opts.body) : undefined);
  });

export interface PlayerSession {
  tenantId: string;
  userId: string;
  externalPlayerId: string;
  /** `authorization: Bearer <access token for audience engagement>`. */
  headers: Record<string, string>;
}

export interface TestTenant {
  tenantId: string;
  /** The tenant slug (its webhook path is `/v1/integrations/<slug>/events`). */
  slug: string;
  /** The production integration credential issued at creation (its `hmac_secret` signs webhooks, X-7). */
  credential: CredentialIssued;
  /** Launches a player of this tenant (the same external id gives the same user). */
  player(externalPlayerId?: string): Promise<PlayerSession>;
  /** Launches a player through a SANDBOX integration credential of this tenant (token claim `sbx: true`, X-3). */
  sandboxPlayer(externalPlayerId?: string): Promise<PlayerSession>;
  /**
   * An access token of this tenant's operator_admin for `audience` (a real login through identity),
   * for the operator routes of engagement and the operator balance read of payments. No header
   * placeholder exists anywhere (D-4, D-12).
   */
  operatorToken(audience: 'identity' | 'engagement' | 'payments'): Promise<string>;
  /** `authorization: Bearer <operatorToken>` ready to spread into request headers. */
  operatorHeaders(
    audience: 'identity' | 'engagement' | 'payments',
  ): Promise<Record<string, string>>;
}

const PW = 'correct horse battery';
const uniq = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * `platform` is the casino platform of the tenant's first (production) credential. The default
 * `sim-casino` is what launches use; an ingest test passes an adapter type (`casino-a`) so the
 * engagement adapter registry can verify that tenant's webhooks (int/all review: the static
 * `ingest-t1/t2` stand-ins are not configured on the stack; identity is the integration source, X-7).
 */
export async function newTenant(opts: { platform?: string } = {}): Promise<TestTenant> {
  const platform = opts.platform ?? 'sim-casino';
  const slug = uniq();
  const email = `boss@${slug}.test`;
  const signup = await call('POST', urls.identity, '/v1/operators/signup', {
    host: 'localhost',
    body: { tenant_name: slug, slug, email, password: PW },
  });
  if (signup.status !== 201) throw new Error(`operator signup failed: ${signup.status}`);
  const login = await call('POST', urls.identity, '/v1/auth/login', {
    host: `${slug}.mio.localhost`,
    body: { email, password: PW, audience: 'identity' },
  });
  const issued = await call('POST', urls.identity, '/v1/credentials', {
    headers: { authorization: `Bearer ${login.json.access_token as string}` },
    body: { platform, environment: 'production' },
  });
  if (issued.status !== 201) throw new Error(`credential issue failed: ${issued.status}`);
  const key = CredentialIssued.parse(issued.json);
  const tenantId = signup.json.tenant.id as string;
  const operatorToken = async (audience: 'identity' | 'engagement' | 'payments') => {
    const res = await call('POST', urls.identity, '/v1/auth/login', {
      host: `${slug}.mio.localhost`,
      body: { email, password: PW, audience },
    });
    if (res.status !== 200) throw new Error(`operator login (${audience}) failed: ${res.status}`);
    return res.json.access_token as string;
  };
  const launchWith = async (
    k: { key_id: string; hmac_secret: string },
    externalPlayerId: string,
  ): Promise<PlayerSession> => {
    const launched = await call('POST', urls.identity, '/v1/auth/launch', {
      body: {
        token: signLaunchToken({
          keyId: k.key_id,
          secret: k.hmac_secret,
          now: Math.floor(Date.now() / 1000),
          externalPlayerId,
          // F7: identity refuses a launch whose `plat` claim differs from the key's platform (401).
          // Both keys of this tenant are issued for `platform`, so the casino signs that one; the
          // fixture default `sim-casino` only matched the default tenant, never a `casino-a` one.
          // No environment claim: the environment is the key's (D-28, X-3), never the token's.
          platform,
        }),
        audience: 'engagement',
      },
    });
    if (launched.status !== 200) throw new Error(`launch failed: ${launched.status}`);
    const session = LaunchResponse.parse(launched.json);
    return {
      tenantId: session.tenant_id,
      userId: session.user_id,
      externalPlayerId,
      headers: { authorization: `Bearer ${session.access_token}` },
    };
  };
  // X-3: a sandbox integration credential (environment: sandbox). A player launched through it gets
  // an access token with `sbx: true`; the environment is identity's, never a client choice.
  let sandboxKey: CredentialIssued | undefined;
  const sandboxCredential = async (): Promise<CredentialIssued> => {
    if (sandboxKey) return sandboxKey;
    const sbx = await call('POST', urls.identity, '/v1/credentials', {
      headers: { authorization: `Bearer ${login.json.access_token as string}` },
      body: { platform, environment: 'sandbox' }, // same platform: same identity user (X-3)
    });
    if (sbx.status !== 201) throw new Error(`sandbox credential issue failed: ${sbx.status}`);
    return (sandboxKey = CredentialIssued.parse(sbx.json));
  };
  return {
    tenantId,
    slug,
    credential: key,
    operatorToken,
    operatorHeaders: async (audience) => ({
      authorization: `Bearer ${await operatorToken(audience)}`,
    }),
    player: (externalPlayerId = `ext-${uniq()}`) => launchWith(key, externalPlayerId),
    sandboxPlayer: async (externalPlayerId = `ext-${uniq()}`) =>
      launchWith(await sandboxCredential(), externalPlayerId),
  };
}
