import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchTransport } from './static-integrations';

/*
 * Final review (question 6): the reward API (`PUT /v1/operator/integrations/:casino/reward-api`,
 * D-27) lets an operator_admin, a tenant-side user, choose the URL engagement POSTs to, with the
 * casino's api key in `x-api-key`. Identity checks only the scheme (http or https). The outbound
 * call is `fetchTransport`: plain `fetch`, which follows redirects and connects to any address.
 * Undici drops only authorization, proxy-authorization, cookie and host on a cross-origin
 * redirect, so `x-api-key` and the body follow the redirect. The URL is resolved at CALL time, so
 * a check at PUT time alone cannot stop DNS rebinding: the choke point is the transport.
 *
 * Contract these tests set for the fix (test owner): the transport refuses loopback, private,
 * link-local (cloud metadata) and unspecified addresses AFTER resolving the name, unless the host is
 * listed in `REWARD_API_ALLOW_HOSTS` (comma separated; compose lists `casino-sim`), and it never
 * follows a redirect (a 3xx is an answer, which the adapters map to `unknown`).
 *
 * Both RED at a4d97bb. Mutations for the fix: drop the address check -> SSRF-1 red; set
 * `redirect: 'follow'` -> SSRF-2 red.
 */

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
}

async function serve(
  handler: (path: string) => { status: number; headers?: Record<string, string> },
): Promise<{ server: Server; port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', headers: req.headers });
    req.resume();
    const out = handler(req.url ?? '');
    res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port, hits };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

const call = (url: string) =>
  fetchTransport({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-api-key': 'casino-secret-k1' },
    body: { reward: 1 },
  }).then(
    (r) => ({ ok: true as const, status: r.status }),
    (e: unknown) => ({ ok: false as const, e }),
  );

describe('final review: the reward API transport is not an SSRF primitive (D-27, question 6)', () => {
  const saved = process.env.REWARD_API_ALLOW_HOSTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.REWARD_API_ALLOW_HOSTS;
    else process.env.REWARD_API_ALLOW_HOSTS = saved;
  });

  it('SSRF-1 a reward API URL that resolves to a loopback address is never connected to (no allow-list)', async () => {
    delete process.env.REWARD_API_ALLOW_HOSTS;
    const internal = await serve(() => ({ status: 200 }));
    try {
      // `localhost` resolves at call time, so a PUT-time literal-IP check would not see it.
      await call(`http://localhost:${internal.port}/internal/v1/anything`);
      await call(`http://127.0.0.1:${internal.port}/internal/v1/anything`);
      expect(internal.hits).toEqual([]);
    } finally {
      await close(internal.server);
    }
  });

  it('SSRF-2 a redirect is not followed: the api key and the body never reach the Location target', async () => {
    process.env.REWARD_API_ALLOW_HOSTS = '127.0.0.1'; // the casino itself is allowed, its redirect is not
    const target = await serve(() => ({ status: 200 }));
    const casino = await serve(() => ({
      status: 307,
      headers: { location: `http://127.0.0.1:${target.port}/latest/meta-data/` },
    }));
    try {
      const out = await call(`http://127.0.0.1:${casino.port}/v1/rewards`);
      expect(target.hits).toEqual([]);
      if (out.ok) expect(out.status).toBe(307);
    } finally {
      await close(casino.server);
      await close(target.server);
    }
  });
});
