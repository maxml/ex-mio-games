import type { CanonicalDepositEvent } from '@ex-mio/contracts';
import type { StoredRule } from '../model/repositories';

export interface Grant {
  rule_id: string;
  rule_version: number;
  wheel_id: string;
  spins: number;
}

/**
 * The single choke point for when a rule version starts: the START OF ITS PUBLISH SECOND, in ms.
 * Casino A reports the deposit time only in whole seconds (`occurred_at = ts * 1000`), while
 * `active_from` is the publish instant in ms. Compared exactly, a deposit made after a publish
 * within the same second would be judged as before it and the newer rule skipped. So the window
 * start is truncated to the precision of the coarsest casino (A: seconds). Decision D-33.
 */
export function startOfPublishSecond(activeFrom: string): number {
  return Math.floor(Date.parse(activeFrom) / 1000) * 1000;
}

/**
 * Pure: the same rules, event and prior grant counts always give the same grants, and nothing is
 * read from the clock (the window is judged at the deposit's `occurred_at`).
 *
 * A rule version applies when `active_from <= occurred_at < active_to` (null = open) and the
 * conditions hold. Per `rule_id` only the HIGHEST version active at `occurred_at` is considered, so
 * a v2 published without closing v1 never double-grants; the grant carries that version's number.
 * `max_grants_per_player` caps how often a rule fires for one player (`priorGrants[rule_id]`).
 */
export function evaluateRules(
  rules: readonly StoredRule[],
  // No player id of any kind: the rules judge the deposit (amount, currency, time), never the casino id.
  event: Omit<CanonicalDepositEvent, 'external_player_id'>,
  priorGrants: Readonly<Record<string, number>>,
): Grant[] {
  const at = Date.parse(event.occurred_at);
  const newest = new Map<string, StoredRule>();
  for (const rule of rules) {
    const d = rule.definition;
    if (startOfPublishSecond(d.active_from) > at) continue;
    if (d.active_to !== null && Date.parse(d.active_to) <= at) continue;
    const best = newest.get(rule.rule_id);
    if (!best || rule.version > best.version) newest.set(rule.rule_id, rule);
  }
  const grants: Grant[] = [];
  for (const rule of newest.values()) {
    const d = rule.definition;
    if (event.amount_minor < d.conditions.min_amount_minor) continue;
    if (d.conditions.currency !== undefined && d.conditions.currency !== event.currency) continue;
    if (
      d.max_grants_per_player !== null &&
      (priorGrants[rule.rule_id] ?? 0) >= d.max_grants_per_player
    ) {
      continue;
    }
    grants.push({
      rule_id: rule.rule_id,
      rule_version: rule.version,
      wheel_id: d.action.wheel_id,
      spins: d.action.spins,
    });
  }
  return grants;
}
