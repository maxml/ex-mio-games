// rc review (test owner): who may attribute a `web.widget_opened` line to a tenant.
//
// `POST /api/widget/opened` is public. Before a launch it reads the tenant from the launch token's
// header `kid` (`key_<tenant hex>_...`) WITHOUT checking the signature (`tenantHintOfLaunchToken`).
// So anyone can write funnel lines into any tenant's analytics with a three-part string they made
// up: no casino key, no launch, no session. The property pinned here: a token whose signature was
// not verified never names the tenant of a product event; only a verified identity does (a player
// session, or a launch token identity has verified).
//
// Was red when written: INV-WEB-AN-1. Mutation for the green pin (INV-WEB-AN-2): in the player-session branch
// of the handler, use `tenantHintOfLaunchToken(ctx.body.token) ?? s.tenantId` -> red.
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const TENANT_A = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const TENANT_B = '0190a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb';
const PLAYER = '0190a1b2-c3d4-7e5f-8a6b-000000000009';
const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const kidOf = (tenant: string) => `key_${tenant.replaceAll('-', '')}_forged`;
/** Made up by anyone: no casino key signed it. */
const forged = (tenant: string, sig = 'not-a-signature') =>
  `${part({ alg: 'HS256', kid: kidOf(tenant) })}.${part({ pid: 'casino-77' })}.${sig}`;

function world() {
  const lines: Record<string, unknown>[] = [];
  const config = readBffConfig({ IDENTITY_URL: 'http://identity' });
  const sessions = createMemorySessionStore();
  // identity answers a launch exchange for TENANT_A only (the stand-in for a verified launch)
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const aud = JSON.parse(init.body as string).audience as string;
    const claims = part({ sub: PLAYER, tid: TENANT_A, roles: ['player'] });
    return new Response(
      JSON.stringify({
        access_token: `h.${claims}.s`,
        token_type: 'Bearer',
        expires_in: 900,
        user_id: PLAYER,
        tenant_id: TENANT_A,
        aud,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const bff = createBff({
    config,
    sessions,
    fetch: fetchImpl,
    productEvents: (l) => void lines.push(l),
  });
  let cookie = '';
  const post = async (path: string, body: unknown) => {
    const res = await bff.handle(
      new Request(`http://web${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
    const set = res.headers.get('set-cookie');
    if (set) cookie = [cookie, set.split(';')[0]!].filter(Boolean).join('; ');
    return { status: res.status };
  };
  return { lines, post };
}

const tenantsOf = (lines: Record<string, unknown>[]) =>
  lines.filter((l) => l.event === 'web.widget_opened').map((l) => l.tenant_id);

describe('rc review: web analytics attribution (D-19, forged launch token)', () => {
  it('INV-WEB-AN-1 a forged or unsigned launch token cannot attribute a widget_opened line to the tenant its kid names', async () => {
    const w = world();
    for (const token of [forged(TENANT_B), forged(TENANT_B, ''), forged(TENANT_B, 'sig')]) {
      const r = await w.post('/api/widget/opened', { token });
      expect(r.status).toBeLessThan(500); // analytics never breaks the widget
    }
    expect(tenantsOf(w.lines)).not.toContain(TENANT_B);
  });

  it('INV-WEB-AN-2 with a player session the verified tenant wins over any token in the body', async () => {
    const w = world();
    expect(
      (await w.post('/api/session/launch', { token: forged(TENANT_A, 'casino-signed') })).status,
    ).toBeLessThan(300);
    await w.post('/api/widget/opened', { token: forged(TENANT_B) });
    expect(tenantsOf(w.lines)).toEqual([TENANT_A]);
  });
});
