import { HttpException, Injectable } from '@nestjs/common';
import {
  DEFAULT_RULE_ID,
  uuidv7,
  type PublishedVersion,
  type PutRuleRequest,
  type PutWheelRequest,
  type RewardTableDefinition,
  type RuleDefinition,
} from '@ex-mio/contracts';
import { Db, type Tx } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { OperatorConfigRepository } from '../model/operator-config.repository';

/** The publisher recorded on rows the service writes itself (the signup default). */
export const SYSTEM_PUBLISHER = 'system';

/**
 * What a new tenant starts with (D-27), so a fresh operator can demo straight away: a wheel whose
 * every prize is small and a rule that gives one spin for a deposit of 20.00 in any currency. Both are
 * ordinary version-1 rows; the operator replaces them by publishing version 2.
 */
export const DEFAULT_WHEEL: RewardTableDefinition = {
  name: 'Default wheel',
  segments: [
    { label: '10 coins', weight: 60, reward: { type: 'coins', amount: 10 } },
    { label: '25 coins', weight: 30, reward: { type: 'coins', amount: 25 } },
    { label: '50 coins', weight: 9, reward: { type: 'coins', amount: 50 } },
    { label: 'Try again', weight: 1, reward: { type: 'nothing' } },
  ],
};
export const DEFAULT_RULE_MIN_AMOUNT_MINOR = 2000;

const fail = (status: number, code: string, message: string): HttpException =>
  new HttpException({ code, message }, status);

const ruleDefinition = (
  input: Pick<PutRuleRequest, 'name' | 'min_amount_minor' | 'currency' | 'spins'> & {
    max_grants_per_player: number | null;
  },
  wheelId: string,
  activeFrom: Date,
): RuleDefinition => ({
  name: input.name,
  trigger: 'deposit.succeeded',
  conditions: {
    min_amount_minor: input.min_amount_minor,
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
  },
  action: { type: 'grant_spins', spins: input.spins, wheel_id: wheelId },
  active_from: activeFrom.toISOString(),
  active_to: null,
  max_grants_per_player: input.max_grants_per_player,
});

/**
 * The operator's wheel and rules (D-27). Each publish appends the next version under a per-tenant
 * lock; nothing is edited in place, so every spin and every credit still resolves to the exact table
 * and rule version it was drawn from (MIO-063). The caller (`createdBy`) is the verified principal.
 */
@Injectable()
export class OperatorConfigService {
  constructor(
    private readonly db: Db,
    private readonly config: OperatorConfigRepository,
  ) {}

  putWheel(input: PutWheelRequest, createdBy: string): Promise<PublishedVersion> {
    const { tenantId } = currentTenant();
    return this.db.tenantTx(async (tx) => {
      await this.config.lock(tx, tenantId);
      const wheelId = input.wheel_id ?? (await this.config.activeWheelId(tx, tenantId)) ?? uuidv7();
      const version = await this.config.insertWheelVersion(tx, {
        tenantId,
        wheelId,
        definition: { name: input.name, segments: input.segments },
        createdBy,
      });
      return { id: wheelId, version };
    });
  }

  putRule(input: PutRuleRequest, createdBy: string): Promise<PublishedVersion> {
    const { tenantId } = currentTenant();
    return this.db.tenantTx(async (tx) => {
      await this.config.lock(tx, tenantId);
      let wheelId = input.wheel_id;
      if (wheelId !== undefined) {
        if (!(await this.config.wheelExists(tx, tenantId, wheelId)))
          throw fail(422, 'wheel_not_found', 'that wheel does not exist for this tenant');
      } else {
        wheelId = await this.config.activeWheelId(tx, tenantId);
        if (wheelId === undefined)
          throw fail(409, 'wheel_missing', 'publish a wheel before a rule that grants spins');
      }
      const version = await this.config.insertRuleVersion(tx, {
        tenantId,
        ruleId: input.rule_id,
        definition: ruleDefinition(input, wheelId, new Date()),
        createdBy,
      });
      return { id: input.rule_id, version };
    });
  }

  /**
   * Runs in the inbox transaction of `identity.tenant.created`. Writes the default wheel and rule
   * only when the tenant has none, so a redelivery, or an operator who published first, is never
   * overwritten.
   */
  async seedDefaults(tx: Tx, tenantId: string, now: Date = new Date()): Promise<void> {
    await this.config.lock(tx, tenantId);
    let wheelId = await this.config.activeWheelId(tx, tenantId);
    if (wheelId === undefined) {
      wheelId = uuidv7();
      await this.config.insertWheelVersion(tx, {
        tenantId,
        wheelId,
        definition: DEFAULT_WHEEL,
        createdBy: SYSTEM_PUBLISHER,
      });
    }
    if (!(await this.config.hasAnyRule(tx, tenantId))) {
      await this.config.insertRuleVersion(tx, {
        tenantId,
        ruleId: DEFAULT_RULE_ID,
        definition: ruleDefinition(
          {
            name: 'Deposit 20.00, 1 spin',
            min_amount_minor: DEFAULT_RULE_MIN_AMOUNT_MINOR,
            spins: 1,
            max_grants_per_player: null,
          },
          wheelId,
          now,
        ),
        createdBy: SYSTEM_PUBLISHER,
      });
    }
  }
}
