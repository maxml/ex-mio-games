import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchTransport } from './static-integrations';

/*
 * Fix-round re-review, coordinator question 6. The F1 transport check, probed with the address forms
 * a URL parser or a resolver turns into loopback: decimal, octal, hex and short IPv4, IPv4-mapped
 * IPv6, `localhost.` with a trailing dot, and a NAME that resolves to loopback at call time (the
 * resolver is stubbed, so the test needs no network). A local server counts the hits: a refused
 * call must never reach it, whatever error it gives.
 *
 * Expected green. Mutations re-applied in the review:
 *  - drop the `isInternalHostLiteral` refusal in fetchTransport -> the literal probes go red;
 *  - drop `lookup: guardedLookup` from the request options -> SSRF-DNS-1/2 red.
 */

let server: Server;
let port: number;
let hits = 0;
const saved = { allow: process.env.REWARD_API_ALLOW_HOSTS, env: process.env.NODE_ENV };

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hits = 0;
  delete process.env.REWARD_API_ALLOW_HOSTS;
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved.allow === undefined) delete process.env.REWARD_API_ALLOW_HOSTS;
  else process.env.REWARD_API_ALLOW_HOSTS = saved.allow;
  process.env.NODE_ENV = saved.env;
});

const call = (url: string) =>
  fetchTransport({ method: 'POST', url, headers: { 'x-api-key': 'k' }, body: { a: 1 } }).then(
    () => 'answered',
    () => 'refused',
  );

describe('fix-round re-review: reward API transport address forms (Q6)', () => {
  it('SSRF-CTRL the probe server is reachable when the host is allow-listed', async () => {
    process.env.REWARD_API_ALLOW_HOSTS = '127.0.0.1';
    expect(await call(`http://127.0.0.1:${port}/x`)).toBe('answered');
    expect(hits).toBe(1);
  });

  it.each([
    ['decimal', () => `http://2130706433:${port}/x`],
    ['octal', () => `http://0177.0.0.1:${port}/x`],
    ['hex short', () => `http://0x7f.1:${port}/x`],
    ['short', () => `http://127.1:${port}/x`],
    ['IPv4-mapped IPv6', () => `http://[::ffff:127.0.0.1]:${port}/x`],
    ['IPv6 loopback', () => `http://[::1]:${port}/x`],
    ['localhost with a trailing dot', () => `http://localhost.:${port}/x`],
    ['0.0.0.0', () => `http://0.0.0.0:${port}/x`],
  ])('SSRF-LIT %s is refused and never reaches the server', async (_n, url) => {
    expect(await call(url())).toBe('refused');
    expect(hits).toBe(0);
  });

  it('SSRF-DNS-1 a name that resolves to loopback at call time is refused', async () => {
    // Answers like the real resolver, in both shapes (`all` or one address), so that without the
    // guard Node's own connect would really reach the loopback server (the mutation is visible).
    jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, opts: unknown, cb: unknown) => {
      const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
      const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
      return all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4);
    }) as never);
    expect(await call(`http://rebind.casino.example:${port}/x`)).toBe('refused');
    expect(hits).toBe(0);
  });

  it('SSRF-DNS-2 a name with one public and one internal answer is refused', async () => {
    jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: unknown) =>
      (cb as (e: null, a: unknown) => void)(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])) as never);
    expect(await call(`http://mixed.casino.example:${port}/x`)).toBe('refused');
    expect(hits).toBe(0);
  });
});
