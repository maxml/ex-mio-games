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
  /** Launches a player of this tenant (the same external id gives the same user). */
  player(externalPlayerId?: string): Promise<PlayerSession>;
}

const PW = 'correct horse battery';
const uniq = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function newTenant(): Promise<TestTenant> {
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
    body: { platform: 'sim-casino' },
  });
  if (issued.status !== 201) throw new Error(`credential issue failed: ${issued.status}`);
  const key = CredentialIssued.parse(issued.json);
  const tenantId = signup.json.tenant.id as string;
  return {
    tenantId,
    async player(externalPlayerId = `ext-${uniq()}`) {
      const launched = await call('POST', urls.identity, '/v1/auth/launch', {
        body: {
          token: signLaunchToken({
            keyId: key.key_id,
            secret: key.hmac_secret,
            now: Math.floor(Date.now() / 1000),
            externalPlayerId,
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
    },
  };
}
