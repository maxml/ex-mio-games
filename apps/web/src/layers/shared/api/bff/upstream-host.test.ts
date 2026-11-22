// @vitest-environment node
// Identity resolves the tenant from the `Host` header; Node's fetch overrides it, so the BFF's default
// fetch must deliver the caller's `Host` to the service. Mutation: make fetchHonouringHost return plain
// `fetch(input, init)` and the first test goes red.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchHonouringHost } from './upstream';

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function listen(): Promise<{ url: string; seen: { host?: string; body: string } }> {
  const seen = { host: undefined as string | undefined, body: '' };
  server = createServer((req, res) => {
    seen.host = req.headers.host;
    req.on('data', (c) => (seen.body += c));
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":1}'));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('fetchHonouringHost', () => {
  it('delivers the caller-set Host header, the method, the body and the answer', async () => {
    const { url, seen } = await listen();
    const res = await fetchHonouringHost(`${url}/v1/auth/login`, {
      method: 'POST',
      headers: { host: 'acme.mio.localhost:3000', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(seen.host).toBe('acme.mio.localhost:3000');
    expect(seen.body).toBe('{"a":1}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
  });
});
