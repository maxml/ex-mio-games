import type { RewardRequest } from '@ex-mio/contracts';
import type { RedemptionRecord } from './ports';

/**
 * The casino request, built from the FROZEN order only (price and mapping on the record, never the
 * live catalog). The same request goes to `issueReward` and to every `getRewardStatus`.
 * Default mapping: the casino amount is `params.amount_minor`, else `params.count`, else the price;
 * the currency is `params.currency` or EUR; the external player id is the player id. The
 * integrations module replaces this when it maps players to casino accounts.
 */
export async function buildRewardRequest(order: RedemptionRecord): Promise<RewardRequest> {
  const { params, type } = order.reward;
  const amount = Number(params['amount_minor'] ?? params['count'] ?? order.price);
  const currency = typeof params['currency'] === 'string' ? params['currency'] : 'EUR';
  return {
    external_player_id: order.playerId,
    reward: { type, amount_minor: amount, currency },
  };
}
