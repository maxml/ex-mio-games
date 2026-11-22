// BFF product analytics (D-19): `POST /api/widget/opened` writes exactly one `web.widget_opened` line that
// conforms to the vendored Varta schema. Only a verified identity (a player session) names the tenant; before
// a launch nothing is written (INV-WEB-AN-1, rc review R3). Mutations that must turn these red: put the
// launch token or an email in props (the schema check and the no-leak test); write the line when nothing
// identifies a tenant.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const schema = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../../../../packages/contracts/schemas/varta-product-event.schema.json',
    ),
    'utf8',
  ),
);
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

const TENANT = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const PLAYER = '0190a1b2-c3d4-7e5f-8a6b-000000000009';
const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const launchToken = (kid: string) =>
  `${part({ alg: 'HS256', kid })}.${part({ pid: 'casino-77' })}.sig`;
const KID = `key_${TENANT.replaceAll('-', '')}_abc123`;

function world() {
  const lines: Record<string, unknown>[] = [];
  const config = readBffConfig({ IDENTITY_URL: 'http://identity' });
  const sessions = createMemorySessionStore();
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const aud = JSON.parse(init.body as string).audience as string;
    const claims = Buffer.from(
      JSON.stringify({ sub: PLAYER, tid: TENANT, roles: ['player'] }),
    ).toString('base64url');
    return new Response(
      JSON.stringify({
        access_token: `h.${claims}.s`,
        token_type: 'Bearer',
        expires_in: 900,
        user_id: PLAYER,
        tenant_id: TENANT,
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
    return { status: res.status, setCookie: set };
  };
  return { lines, post };
}

describe('POST /api/widget/opened', () => {
  it('before a launch: an unverified launch token writes no line and sets no cookie (INV-WEB-AN-1)', async () => {
    const w = world();
    const r = await w.post('/api/widget/opened', { token: launchToken(KID) });
    expect(r.status).toBe(204);
    expect(w.lines).toEqual([]);
    expect(r.setCookie).toBeNull();
  });

  it('after a launch: one conforming line with the verified player and tenant, never the launch token or the casino id', async () => {
    const w = world();
    const token = launchToken(KID);
    await w.post('/api/session/launch', { token });
    w.lines.length = 0;
    const r = await w.post('/api/widget/opened', { token });
    expect(r.status).toBe(204);
    expect(w.lines).toHaveLength(1);
    const line = w.lines[0]!;
    expect(validate(JSON.parse(JSON.stringify(line)))).toBe(true);
    expect(line).toMatchObject({
      kind: 'product_event',
      event: 'web.widget_opened',
      tenant_id: TENANT,
      actor_type: 'player',
      actor_id: PLAYER,
      props: { launched: true },
      service: 'web',
    });
    // closed envelope (VAR-6): nothing the collector would strip or drop
    for (const k of ['msg', 'pid', 'hostname', 'time']) expect(line).not.toHaveProperty(k);
    expect(Object.keys(line).every((k) => k in schema.properties)).toBe(true);
    expect(line).not.toHaveProperty('anon_id');
    expect(JSON.stringify(line)).not.toContain(token);
    expect(JSON.stringify(line)).not.toContain('casino-77');
  });

  it('writes nothing when no tenant can be named (no session, no usable token)', async () => {
    const w = world();
    expect((await w.post('/api/widget/opened', {})).status).toBe(204);
    expect((await w.post('/api/widget/opened', { token: 'garbage' })).status).toBe(204);
    expect(
      (await w.post('/api/widget/opened', { token: launchToken('key_nothex_x') })).status,
    ).toBe(204);
    expect(w.lines).toEqual([]);
  });

  it('a stray anon cookie neither names a tenant nor reaches a line', async () => {
    const w = world();
    const res = await createBff({
      config: readBffConfig({}),
      sessions: createMemorySessionStore(),
      productEvents: (l) => void w.lines.push(l),
    }).handle(
      new Request('http://web/api/widget/opened', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'mio_anon=anon:evil@x.io' },
        body: JSON.stringify({ token: launchToken(KID) }),
      }),
    );
    expect(res.status).toBe(204);
    expect(w.lines).toEqual([]);
  });
});
