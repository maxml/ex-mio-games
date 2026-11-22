import {
  IssueDeadlineMs,
  PlayerLinkResponse,
  RewardRequest,
  TenantIntegration as TenantIntegrationSchema,
  type CasinoPlayerPort,
  type CasinoRewardApiConfig,
} from '@ex-mio/contracts';
import type { Transport, TransportRequest } from './adapter';
import { createDefaultRegistry } from './registry'; // RED: module missing
import {
  createCasinoPlayerPort,
  createRewardRequestBuilder,
  createTenantCasinoPorts,
} from './tenant-ports'; // RED: module missing
import type { TenantIntegration, TenantIntegrationPort } from './ports';

/**
 * The adapter registry per tenant and the casino player id from the mapping (coordinator decision
 * D-12, review R2-1; docs/specs/engagement-ingest.md section 3.4). Real default registry, real
 * adapters, a recording transport: the oracle is which URL and which credentials a request carries.
 *
 * Mutations (each turns the named tests red):
 *  - resolve the adapter with the first tenant's config for every tenant (a module-level cache keyed
 *    by adapter type)                                              -> INV-REG-PER-TENANT.
 *  - ignore `issue_deadline_ms` of the tenant, or hard-code one     -> INV-REG-DEADLINE.
 *  - fall back to `base_url` when there is no sandbox endpoint, or ignore `sandbox`
 *                                                                   -> INV-REG-SANDBOX.
 *  - return a port for a suspended tenant or an unknown adapter type; swallow a failing
 *    integration lookup as `undefined` (the saga would read it as "no adapter" and refund)
 *                                                                   -> INV-REG-ABSENT.
 *  - send `external_player_id` = our user id, or a mapping copy kept in engagement
 *                                                                   -> INV-REQ-MAPPING.
 */

const T1 = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const T2 = '0190a1b2-c3d4-4e5f-8a6b-000000000002';
const T3 = '0190a1b2-c3d4-4e5f-8a6b-000000000003';
const T4 = '0190a1b2-c3d4-4e5f-8a6b-000000000004';
const T5 = '0190a1b2-c3d4-4e5f-8a6b-000000000005';
const U1 = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';
const U2 = '0190a1b2-c3d4-4e5f-8a6b-0000000000a2';

// X-7: built from identity's contract type, so a drift between what identity serves and what the
// ports read fails here (parse), not at integration.
const integ = (
  tenant_id: string,
  platform: string,
  reward_api: CasinoRewardApiConfig | undefined,
  status: 'active' | 'suspended' = 'active',
): TenantIntegration =>
  TenantIntegrationSchema.parse({
    tenant_id,
    platform,
    status,
    environment: 'production',
    webhook_secrets: ['s'],
    player_hash_key: 'k'.repeat(32),
    ...(reward_api ? { reward_api } : {}),
  });

const TENANTS: Record<string, TenantIntegration> = {
  [T1]: integ(T1, 'casino-a', {
    base_url: 'https://a1.prod.test',
    api_key: 'key-a1-prod',
    sandbox_base_url: 'https://a1.sandbox.test',
    sandbox_api_key: 'key-a1-sandbox',
  }),
  [T2]: integ(T2, 'casino-b', {
    base_url: 'https://b2.prod.test',
    api_key: 'key-b2-prod',
    issue_deadline_ms: 120_000,
  }),
  [T3]: integ(T3, 'casino-a', { base_url: 'https://a3.prod.test' }, 'suspended'),
  [T4]: integ(T4, 'casino-zzz', { base_url: 'https://z4.prod.test' }),
  [T5]: integ(T5, 'casino-a', undefined),
};

const REWARD = { type: 'bonus', amount_minor: 500, currency: 'EUR' } as const;
const request = (sandbox: boolean): RewardRequest => ({
  external_player_id: 'pl-1',
  reward: REWARD,
  sandbox,
});

function setup(over: Partial<TenantIntegrationPort> = {}) {
  const seen: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    if (req.url.includes('/casino-b/')) return { status: 202, body: { ticket: 'T-1' } }; // casino B
    return { status: 200, body: { bonusId: 'A-1', status: 'ISSUED' } }; // casino A
  };
  const integrations: TenantIntegrationPort = {
    lookup: async () => undefined,
    lookupById: async (id) => TENANTS[id],
    ...over,
  };
  const ports = createTenantCasinoPorts({
    integrations,
    registry: createDefaultRegistry(),
    transport,
    timeoutMs: 50,
  });
  const carries = (req: TransportRequest, secret: string) =>
    JSON.stringify(req.headers).includes(secret) || JSON.stringify(req.body ?? '').includes(secret);
  return { ports, seen, carries };
}

describe('adapter registry per tenant', () => {
  it('INV-REG-PER-TENANT: each tenant gets its own adapter type, base URL and credentials; nothing leaks across tenants', async () => {
    const { ports, seen, carries } = setup();
    const a = await ports.forTenant(T1, { sandbox: false });
    const b = await ports.forTenant(T2, { sandbox: false });
    expect(a?.info).toMatchObject({ recovery_mode: 'native_lookup', sandbox: false });
    expect(b?.info).toMatchObject({ recovery_mode: 'idempotent_replay', sandbox: false });

    await a!.port.issueReward(request(false), 'redeem:1');
    await b!.port.issueReward(request(false), 'redeem:2');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url.startsWith('https://a1.prod.test')).toBe(true);
    expect(seen[1]!.url.startsWith('https://b2.prod.test')).toBe(true);
    expect(seen[0]!.url).toContain('/casino-a/');
    expect(seen[1]!.url).toContain('/casino-b/');
    expect(carries(seen[0]!, 'key-a1-prod')).toBe(true);
    expect(carries(seen[0]!, 'key-b2-prod')).toBe(false);
    expect(carries(seen[1]!, 'key-b2-prod')).toBe(true);
    expect(carries(seen[1]!, 'key-a1-prod')).toBe(false);
  });

  it('INV-REG-DEADLINE: the issue deadline is the tenant override, else the adapter type default, always within bounds', async () => {
    const { ports } = setup();
    const defaults = createDefaultRegistry();
    const a = await ports.forTenant(T1, { sandbox: false });
    expect(a?.info.issue_deadline_ms).toBe(defaults.get('casino-a')!.issueDeadlineMs);
    const b = await ports.forTenant(T2, { sandbox: false });
    expect(b?.info.issue_deadline_ms).toBe(120_000); // the tenant's own
    for (const r of [a, b])
      expect(IssueDeadlineMs.safeParse(r!.info.issue_deadline_ms).success).toBe(true);
  });

  it('INV-REG-SANDBOX: a sandbox port talks to the sandbox endpoint and key only; the production endpoint is never touched; no sandbox endpoint, no sandbox port', async () => {
    const { ports, seen, carries } = setup();
    const sb = await ports.forTenant(T1, { sandbox: true });
    expect(sb?.info).toMatchObject({ sandbox: true });
    await sb!.port.issueReward(request(true), 'redeem:sb');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.startsWith('https://a1.sandbox.test')).toBe(true);
    expect(carries(seen[0]!, 'key-a1-sandbox')).toBe(true);
    expect(carries(seen[0]!, 'key-a1-prod')).toBe(false);
    expect(seen.some((r) => r.url.includes('a1.prod.test'))).toBe(false);

    // the production port refuses a sandbox request (and the reverse) before any I/O
    const prod = await ports.forTenant(T1, { sandbox: false });
    expect(await prod!.port.issueReward(request(true), 'redeem:sb2')).toMatchObject({
      kind: 'rejected',
    });
    expect(await sb!.port.issueReward(request(false), 'redeem:sb3')).toMatchObject({
      kind: 'rejected',
    });
    expect(seen).toHaveLength(1);

    // tenant 2 has no sandbox endpoint: no port, and never the production one in its place
    expect(await ports.forTenant(T2, { sandbox: true })).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('INV-REG-ABSENT: unknown tenant, suspended tenant, unknown adapter type and no reward API resolve to undefined; a failing integration lookup is an error, not "absent"', async () => {
    const { ports } = setup();
    const unknown = '0190a1b2-c3d4-4e5f-8a6b-0000000000ff';
    for (const id of [unknown, T3, T4, T5]) {
      expect([id, await ports.forTenant(id, { sandbox: false })]).toEqual([id, undefined]);
    }
    const down = setup({
      lookupById: async () => {
        throw new Error('identity unreachable');
      },
    });
    await expect(down.ports.forTenant(T1, { sandbox: false })).rejects.toThrow(
      'identity unreachable',
    );
  });
});

describe('the casino player id comes from the mapping', () => {
  const mapping = new Map<string, { platform: string; external_player_id: string }>([
    [`${T1}|${U1}`, { platform: 'casino-a', external_player_id: 'ext-777' }],
    [`${T1}|${U2}`, { platform: 'casino-a', external_player_id: 'ext-888' }],
  ]);
  const asked: Array<[string, string]> = [];
  const players: CasinoPlayerPort = {
    externalPlayerId: async (tenantId, userId) => {
      asked.push([tenantId, userId]);
      return mapping.get(`${tenantId}|${userId}`);
    },
  };

  it('INV-REQ-MAPPING: external_player_id is the mapped casino id of THIS user, never our user id; sandbox is carried', async () => {
    const builder = createRewardRequestBuilder({ players });
    const one = await builder.build({ tenantId: T1, userId: U1, reward: REWARD, sandbox: false });
    const two = await builder.build({ tenantId: T1, userId: U2, reward: REWARD, sandbox: true });
    expect(one).toEqual({ external_player_id: 'ext-777', reward: REWARD, sandbox: false });
    expect(two).toEqual({ external_player_id: 'ext-888', reward: REWARD, sandbox: true });
    expect(RewardRequest.safeParse(one).success).toBe(true);
    expect(asked).toEqual([
      [T1, U1],
      [T1, U2],
    ]);
  });

  it('INV-REQ-MAPPING: no mapping row (erased or never created) gives undefined; the id is not guessed from the user id or from another tenant', async () => {
    const builder = createRewardRequestBuilder({ players });
    expect(
      await builder.build({ tenantId: T1, userId: 'no-such-user', reward: REWARD, sandbox: false }),
    ).toBeUndefined();
    expect(
      await builder.build({ tenantId: T2, userId: U1, reward: REWARD, sandbox: false }),
    ).toBeUndefined(); // U1 is mapped in T1 only
  });
});

// X-8: the port is backed by identity's reverse link route (`INTERNAL_ROUTES.playerLink`), the only
// writer and reader of the mapping. Engagement keeps no copy.
describe('the casino player port is backed by the identity player link', () => {
  const calls: Array<[string, string]> = [];
  const identity = {
    playerLink: async (tenantId: string, userId: string) => {
      calls.push([tenantId, userId]);
      if (userId === U1)
        return PlayerLinkResponse.parse({ platform: 'casino-a', external_player_id: 'ext-777' });
      if (userId === 'down') throw new Error('identity unreachable');
      return undefined; // 404: never linked, or erased
    },
  };

  // Mutation: keep a local copy of the mapping, guess the id from the user id, or treat an
  // identity outage as "no mapping" (the saga would read that as player_unmapped, not as transport).
  it('INV-REQ-LINK: the id is what the link route returns for THIS tenant and user; 404 is undefined; an outage is an error', async () => {
    const port = createCasinoPlayerPort({ identity });
    expect(await port.externalPlayerId(T1, U1)).toEqual({
      platform: 'casino-a',
      external_player_id: 'ext-777',
    });
    expect(await port.externalPlayerId(T1, U2)).toBeUndefined();
    await expect(port.externalPlayerId(T1, 'down')).rejects.toThrow('identity unreachable');
    expect(calls).toEqual([
      [T1, U1],
      [T1, U2],
      [T1, 'down'],
    ]);
  });
});
