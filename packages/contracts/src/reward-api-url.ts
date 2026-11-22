/*
 * The one https rule for a casino reward API (D-30, D-31 R4), read by identity (the PUT refuses)
 * and by engagement (the call refuses). "https only in production" means the DEPLOYMENT
 * (`NODE_ENV=production`), for every reward API, sandbox and production integrations alike. Plain
 * http is allowed only for hosts listed in `REWARD_API_ALLOW_HOSTS` (comma separated, compose lists
 * `casino-sim`), or outside a production deployment. The two services must never disagree, so the
 * rule lives here and both call it.
 */

export type RewardApiEnv = {
  NODE_ENV?: string | undefined;
  REWARD_API_ALLOW_HOSTS?: string | undefined;
};

/** The hosts exempt from the https and address rules, lower-case, from `REWARD_API_ALLOW_HOSTS`. */
export function rewardApiAllowedHosts(env: RewardApiEnv = process.env): Set<string> {
  return new Set(
    (env.REWARD_API_ALLOW_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ''),
  );
}

/** Strip the brackets of an IPv6 literal and lower-case, the form the allow-list compares. */
export const rewardApiHostKey = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[|\]$/g, '');

/** True when this URL must be refused for using plain http where https is required. */
export function rewardApiRequiresHttps(url: URL, env: RewardApiEnv = process.env): boolean {
  return (
    url.protocol === 'http:' &&
    env.NODE_ENV === 'production' &&
    !rewardApiAllowedHosts(env).has(rewardApiHostKey(url.hostname))
  );
}

export const REWARD_API_HTTPS_MESSAGE =
  'a reward API must use https in production (http only for hosts in REWARD_API_ALLOW_HOSTS)';
