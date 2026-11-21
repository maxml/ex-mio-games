import type {
  CasinoPlayerPort,
  CasinoRewardPorts,
  RewardRequest,
  RewardRequestBuilder,
} from '@ex-mio/contracts';
import type { AdapterRegistry, Transport } from './adapter';
import type { TenantIntegrationPort } from './ports';

/**
 * The adapter registry per tenant (decision D-12, spec section 3.4). The adapter type, the base URL
 * and the credentials are read from the tenant's own integration record on every call: nothing is
 * cached across tenants. Absent means `undefined` (unknown or suspended tenant, unknown adapter type,
 * no reward API, a sandbox request without a sandbox endpoint: the production adapter is never the
 * fallback). A failing integration lookup is NOT absent: the promise rejects so the caller retries
 * instead of reading it as "no adapter" and refunding.
 */
export function createTenantCasinoPorts(deps: {
  integrations: TenantIntegrationPort;
  registry: AdapterRegistry;
  transport: Transport;
  timeoutMs?: number;
}): CasinoRewardPorts {
  return {
    async forTenant(tenantId, opts) {
      const integration = await deps.integrations.lookupById(tenantId);
      if (!integration || integration.status !== 'active') return undefined;
      const entry = deps.registry.get(integration.casino);
      const api = integration.reward_api;
      if (!entry || !api) return undefined;
      const baseUrl = opts.sandbox ? api.sandbox_base_url : api.base_url;
      if (!baseUrl) return undefined;
      const apiKey = opts.sandbox ? api.sandbox_api_key : api.api_key;
      const adapter = entry.create({
        baseUrl,
        transport: deps.transport,
        sandbox: opts.sandbox,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      return {
        port: adapter,
        info: {
          recovery_mode: entry.recoveryMode,
          issue_deadline_ms: api.issue_deadline_ms ?? entry.issueDeadlineMs,
          sandbox: opts.sandbox,
        },
      };
    },
  };
}

/**
 * Builds the frozen reward request of an order. The casino player id is the identity player mapping's
 * (the only place the raw id lives, MIO-107); no mapping row gives `undefined`, never a guess.
 */
export function createRewardRequestBuilder(deps: {
  players: CasinoPlayerPort;
}): RewardRequestBuilder {
  return {
    async build(input): Promise<RewardRequest | undefined> {
      const mapped = await deps.players.externalPlayerId(input.tenantId, input.userId);
      if (!mapped) return undefined;
      return {
        external_player_id: mapped.external_player_id,
        reward: input.reward,
        sandbox: input.sandbox,
      };
    },
  };
}
