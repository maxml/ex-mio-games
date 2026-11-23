// Hostile review of the operator UI rework (6488273..a531b7b). Written by the reviewer.
// Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-review.md, UIR-1.
//
// UIR-1 (major, defect, it.fails), the BFF half: engagement's operator list returns a redemption waiting
// for review as `status: 'pending'` (the public enum) plus `state: 'NEEDS_REVIEW'`. GET /api/operator/state
// keeps only `status`, so the console cannot tell a review row from an ordinary pending one, and the
// Redemptions page (which draws Resolve only for 'needs_review') never offers the resolve flow the IA spec
// puts on that page. Goes green when the state row says "needs review" (as `status: 'needs_review'` or
// as `state: 'NEEDS_REVIEW'`).
import { describe, expect, it } from 'vitest';
import { readBffConfig } from './config';
import { createBff } from './handlers';
import { createMemorySessionStore } from './session';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const ITEM = {
  id: U(2),
  name: '10 EUR cash bonus',
  description: 'd',
  image_url: null,
  price: 500,
  reward: { type: 'cash_bonus', params: {} },
  stock: null,
  per_player_limit: null,
  active: true,
  version: 1,
};
const IN_REVIEW = {
  id: U(3),
  item_id: U(2),
  price: 500,
  status: 'pending',
  state: 'NEEDS_REVIEW',
  attempts: 3,
  casino_reference: null,
  failure_reason: 'casino answered 500 three times',
  history: [],
  created_at: '2026-11-21T10:00:00.000Z',
  updated_at: '2026-11-21T10:05:00.000Z',
};

const ROUTES: Record<string, { status?: number; body?: unknown }> = {
  'GET /v1/billing/plans': { body: [] },
  'GET /v1/billing/subscription': { status: 404, body: { message: 'x', code: 'not_found' } },
  'GET /v1/billing/invoices': { body: [] },
  'GET /v1/billing/usage': { status: 404, body: { message: 'x', code: 'not_found' } },
  'GET /v1/store/items': { body: [ITEM] },
  'GET /v1/operator/redemptions': { body: [IN_REVIEW] },
};

async function operatorState() {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (method === 'POST' && u.pathname === '/v1/auth/login') {
      const { audience } = JSON.parse(init.body as string) as { audience: string };
      const token = jwt({ sub: U(9), tid: U(8), roles: ['operator_admin'], aud: audience });
      return new Response(
        JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 900 }),
      );
    }
    const r = ROUTES[`${method} ${u.pathname}`];
    if (!r) return new Response(JSON.stringify({ message: 'no', code: 'nope' }), { status: 404 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const bff = createBff({
    config: readBffConfig({
      IDENTITY_URL: 'http://identity',
      PAYMENTS_URL: 'http://payments',
      ENGAGEMENT_URL: 'http://engagement',
    }),
    sessions: createMemorySessionStore(),
    fetch: fetchImpl,
  });
  const login = await bff.handle(
    new Request('http://web/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct horse' }),
    }),
  );
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const res = await bff.handle(
    new Request('http://web/api/operator/state', { headers: { cookie } }),
  );
  return {
    status: res.status,
    body: (await res.json()) as { redemptions: Record<string, unknown>[] },
  };
}

describe('UIR-1 the operator state tells a review row apart (BFF half)', () => {
  it('the fixture reaches the mapping (guard against a vacuous red)', async () => {
    const r = await operatorState();
    expect(r.status).toBe(200);
    expect(r.body.redemptions).toHaveLength(1);
    expect(r.body.redemptions[0]).toMatchObject({ item: '10 EUR cash bonus' });
  });

  // DEFECT: the row comes out as { status: 'pending' } with no `state`.
  it.fails(
    'a NEEDS_REVIEW redemption is marked as needing review in /api/operator/state',
    async () => {
      const row = (await operatorState()).body.redemptions[0]!;
      expect(row.status === 'needs_review' || row.state === 'NEEDS_REVIEW').toBe(true);
    },
  );
});
