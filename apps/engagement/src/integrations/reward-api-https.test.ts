import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchTransport } from './static-integrations';

/*
 * D-30: https only in production; http only for hosts in REWARD_API_ALLOW_HOSTS. The frozen SSRF
 * tests run with NODE_ENV=test, so they do not see this rule.
 * Mutation: drop the `NODE_ENV === 'production'` refusal in fetchTransport -> HTTPS-PROD-1 red.
 */
const req = (url: string) =>
  ({ method: 'POST', url, headers: {}, body: { a: 1 } }) as Parameters<typeof fetchTransport>[0];

describe('reward API transport: https in production (D-30)', () => {
  const saved = { env: process.env.NODE_ENV, allow: process.env.REWARD_API_ALLOW_HOSTS };
  const restore = (k: 'NODE_ENV' | 'REWARD_API_ALLOW_HOSTS', v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    restore('NODE_ENV', saved.env);
    restore('REWARD_API_ALLOW_HOSTS', saved.allow);
  });

  it('HTTPS-PROD-1 plain http to a host that is not allow-listed is refused in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REWARD_API_ALLOW_HOSTS;
    await expect(fetchTransport(req('http://rewards.casino.example/v1'))).rejects.toThrow(
      /https in production/,
    );
  });

  it('HTTPS-PROD-2 an allow-listed host may use http in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.REWARD_API_ALLOW_HOSTS = '127.0.0.1';
    const server = createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const out = await fetchTransport(req(`http://127.0.0.1:${port}/x`));
      expect(out).toEqual({ status: 200, body: { ok: true } });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
