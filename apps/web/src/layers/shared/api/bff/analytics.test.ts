// BFF product analytics (D-19): `POST /api/widget/opened` writes exactly one `web.widget_opened` line that
// conforms to the vendored Varta schema. Before a launch the actor is an anonymous visitor (`anon_id`); with
// a player session it is the verified player. Mutations that must turn these red: put the launch token or
// an email in props (the schema check and the no-leak test); write the line when nothing identifies a tenant.
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
  it('before a launch: one conforming line with an anonymous id, never the launch token or the casino id', async () => {
    const w = world();
    const token = launchToken(KID);
    const r = await w.post('/api/widget/opened', { token });
    expect(r.status).toBe(204);
    expect(w.lines).toHaveLength(1);
    const line = w.lines[0]!;
    expect(validate(JSON.parse(JSON.stringify(line)))).toBe(true);
    expect(line).toMatchObject({
      kind: 'product_event',
      event: 'web.widget_opened',
      tenant_id: TENANT,
      actor_type: 'visitor',
      props: { launched: false },
      service: 'web',
    });
    // closed envelope (VAR-6): nothing the collector would strip or drop
    for (const k of ['msg', 'pid', 'hostname', 'time']) expect(line).not.toHaveProperty(k);
    expect(Object.keys(line).every((k) => k in schema.properties)).toBe(true);
    expect(line.anon_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(line).not.toHaveProperty('actor_id');
    expect(JSON.stringify(line)).not.toContain(token);
    expect(JSON.stringify(line)).not.toContain('casino-77');
    // the anonymous id is a session cookie of ours
    expect(r.setCookie).toMatch(/^mio_anon=[0-9a-f-]{36}; Path=\/; HttpOnly/);
    expect(r.setCookie).not.toMatch(/Max-Age|Expires/);
  });

  it('a second open from the same browser keeps the same anon_id and sets no new cookie', async () => {
    const w = world();
    await w.post('/api/widget/opened', { token: launchToken(KID) });
    const second = await w.post('/api/widget/opened', { token: launchToken(KID) });
    expect(second.setCookie).toBeNull();
    expect(w.lines).toHaveLength(2);
    expect(w.lines[1]!.anon_id).toBe(w.lines[0]!.anon_id);
    expect(w.lines[1]!.event_id).not.toBe(w.lines[0]!.event_id);
  });

  it('after a launch: the verified player and tenant, no anon_id', async () => {
    const w = world();
    await w.post('/api/session/launch', { token: 'x'.repeat(40) });
    w.lines.length = 0;
    const r = await w.post('/api/widget/opened', {});
    expect(r.status).toBe(204);
    expect(w.lines).toHaveLength(1);
    const line = w.lines[0]!;
    expect(validate(JSON.parse(JSON.stringify(line)))).toBe(true);
    expect(line).toMatchObject({
      tenant_id: TENANT,
      actor_type: 'player',
      actor_id: PLAYER,
      props: { launched: true },
    });
    expect(line).not.toHaveProperty('anon_id');
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

  it('ignores a forged anon cookie that is not a UUID', async () => {
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
    expect(w.lines).toHaveLength(1);
    expect(JSON.stringify(w.lines[0])).not.toContain('evil');
    expect(validate(JSON.parse(JSON.stringify(w.lines[0])))).toBe(true);
  });
});
