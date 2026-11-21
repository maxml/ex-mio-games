import type { RewardRequest } from '@ex-mio/contracts';
import type { RedemptionRecord } from './ports';

/**
 * The reward part of the casino request, from the FROZEN order only (price and mapping on the
 * record, never the live catalog). Default mapping: the casino amount is `params.amount_minor`,
 * else `params.count`, else the price; the currency is `params.currency` or EUR.
 *
 * The player part is NOT here: the casino's own id of the player comes from identity's player link
 * through `RewardRequestBuilder` (`integrations/tenant-ports.ts`, D-20), never from the user id and
 * never guessed. The whole built request is frozen on the order at RESERVED -> ISSUING.
 */
export function rewardOfOrder(order: RedemptionRecord): RewardRequest['reward'] {
  const { params, type } = order.reward;
  const amount = Number(params['amount_minor'] ?? params['count'] ?? order.price);
  const currency = typeof params['currency'] === 'string' ? params['currency'] : 'EUR';
  return { type, amount_minor: amount, currency } as RewardRequest['reward'];
}
