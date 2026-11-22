import 'reflect-metadata';
import { RuleDefinition, RewardTableDefinition } from '@ex-mio/contracts';
import { runWithTenant } from '@ex-mio/tenancy';
import type { OperatorConfigRepository } from '../model/operator-config.repository';
import { evaluateRules } from './rules.engine';
import { DEFAULT_WHEEL, OperatorConfigService, SYSTEM_PUBLISHER } from './operator-config.service';

/*
 * The operator's wheel and rules (D-27) over an in-memory twin of the repository: versions append
 * per tenant, a tenant only ever reads or writes its own rows, every row names its publisher, the
 * default seed runs once and never overwrites what an operator published.
 */

const A = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const B = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';

interface WheelRow {
  tenantId: string;
  wheelId: string;
  version: number;
  definition: RewardTableDefinition;
  createdBy: string;
}
interface RuleRow {
  tenantId: string;
  ruleId: string;
  version: number;
  definition: RuleDefinition;
  createdBy: string;
}

class FakeRepo {
  wheels: WheelRow[] = [];
  rules: RuleRow[] = [];
  locks: string[] = [];
  async lock(_tx: unknown, tenantId: string) {
    this.locks.push(tenantId);
  }
  async activeWheelId(_tx: unknown, tenantId: string) {
    return [...this.wheels].reverse().find((w) => w.tenantId === tenantId)?.wheelId;
  }
  async wheelExists(_tx: unknown, tenantId: string, wheelId: string) {
    return this.wheels.some((w) => w.tenantId === tenantId && w.wheelId === wheelId);
  }
  async insertWheelVersion(
    _tx: unknown,
    i: { tenantId: string; wheelId: string; definition: RewardTableDefinition; createdBy: string },
  ) {
    const version =
      Math.max(
        0,
        ...this.wheels
          .filter((w) => w.tenantId === i.tenantId && w.wheelId === i.wheelId)
          .map((w) => w.version),
      ) + 1;
    this.wheels.push({ ...i, version });
    return version;
  }
  async insertRuleVersion(
    _tx: unknown,
    i: { tenantId: string; ruleId: string; definition: RuleDefinition; createdBy: string },
  ) {
    const version =
      Math.max(
        0,
        ...this.rules
          .filter((r) => r.tenantId === i.tenantId && r.ruleId === i.ruleId)
          .map((r) => r.version),
      ) + 1;
    this.rules.push({ ...i, version });
    return version;
  }
  async hasAnyRule(_tx: unknown, tenantId: string) {
    return this.rules.some((r) => r.tenantId === tenantId);
  }
}

const setup = () => {
  const repo = new FakeRepo();
  const db = { tenantTx: <T>(fn: (tx: unknown) => Promise<T>) => fn({}) };
  const service = new OperatorConfigService(
    db as never,
    repo as unknown as OperatorConfigRepository,
  );
  const as = <T>(tenantId: string, fn: () => Promise<T>) =>
    runWithTenant({ tenantId, principalId: 'p' }, fn);
  return { repo, service, as };
};

const input = {
  name: 'W',
  segments: [{ label: 'x', weight: 3, reward: { type: 'coins' as const, amount: 10 } }],
};
const ruleInput = {
  rule_id: 'deposit',
  name: 'R',
  min_amount_minor: 1000,
  spins: 2,
  max_grants_per_player: null,
};

describe('OperatorConfigService (D-27)', () => {
  it('publishes versions: the first call creates the wheel, later calls add a version of the same wheel', async () => {
    const { service, repo, as } = setup();
    const first = await as(A, () => service.putWheel(input, 'admin-1'));
    const second = await as(A, () => service.putWheel({ ...input, name: 'W2' }, 'admin-1'));
    expect(first.version).toBe(1);
    expect(second).toEqual({ id: first.id, version: 2 });
    expect(repo.wheels.map((w) => w.version)).toEqual([1, 2]);
  });

  // Mutation: take the tenant from anything but the ambient (token) tenant.
  it('tenant isolation: rows are written under the ambient tenant, the other tenant sees none of them', async () => {
    const { service, repo, as } = setup();
    const a = await as(A, () => service.putWheel(input, 'admin-a'));
    await as(A, () => service.putRule(ruleInput, 'admin-a'));
    expect(repo.wheels.every((w) => w.tenantId === A)).toBe(true);
    expect(repo.rules.every((r) => r.tenantId === A)).toBe(true);
    // B has no wheel: its rule is refused, it cannot name A's wheel, and A's wheel is untouched.
    await expect(as(B, () => service.putRule(ruleInput, 'admin-b'))).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      as(B, () => service.putRule({ ...ruleInput, wheel_id: a.id }, 'admin-b')),
    ).rejects.toMatchObject({ status: 422 });
    expect(repo.rules).toHaveLength(1);
    const b = await as(B, () => service.putWheel(input, 'admin-b'));
    expect(b.id).not.toBe(a.id);
    expect(b.version).toBe(1);
    expect(repo.wheels.filter((w) => w.tenantId === A)).toHaveLength(1);
  });

  it('is audited: every version records its publisher, and the publish is serialised per tenant', async () => {
    const { service, repo, as } = setup();
    await as(A, () => service.putWheel(input, 'admin-a'));
    await as(A, () => service.putRule(ruleInput, 'admin-a2'));
    expect(repo.wheels[0]?.createdBy).toBe('admin-a');
    expect(repo.rules[0]?.createdBy).toBe('admin-a2');
    expect(repo.locks).toEqual([A, A]);
  });

  it('a rule defaults to the active wheel and becomes version 2 under the same rule id', async () => {
    const { service, repo, as } = setup();
    const w = await as(A, () => service.putWheel(input, 'a'));
    await as(A, () => service.putRule(ruleInput, 'a'));
    const v2 = await as(A, () => service.putRule({ ...ruleInput, min_amount_minor: 5000 }, 'a'));
    expect(v2).toEqual({ id: 'deposit', version: 2 });
    expect(RuleDefinition.parse(repo.rules[1]!.definition).action.wheel_id).toBe(w.id);
  });

  describe('seedDefaults on signup', () => {
    it('writes a valid default wheel and a rule that grants a spin for a 20.00 deposit', async () => {
      const { service, repo } = setup();
      await service.seedDefaults({}, A, new Date('2026-11-22T00:00:00Z'));
      expect(RewardTableDefinition.parse(repo.wheels[0]!.definition)).toEqual(DEFAULT_WHEEL);
      expect(repo.wheels[0]?.createdBy).toBe(SYSTEM_PUBLISHER);
      const stored = repo.rules.map((r) => ({
        rule_id: r.ruleId,
        version: r.version,
        definition: RuleDefinition.parse(r.definition),
      }));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.definition.action.wheel_id).toBe(repo.wheels[0]?.wheelId);
      const deposit = (amount: number) => ({
        amount_minor: amount,
        currency: 'EUR',
        occurred_at: '2026-11-23T00:00:00.000Z',
      });
      const grants = (amount: number) => evaluateRules(stored, deposit(amount) as never, {});
      expect(grants(2000)).toHaveLength(1);
      expect(grants(1999)).toHaveLength(0);
    });

    it('is idempotent and never overwrites what the operator published first', async () => {
      const { service, repo, as } = setup();
      await as(A, () => service.putWheel(input, 'admin-a'));
      await service.seedDefaults({}, A);
      await service.seedDefaults({}, A);
      expect(repo.wheels).toHaveLength(1);
      expect(repo.wheels[0]?.createdBy).toBe('admin-a');
      expect(repo.rules).toHaveLength(1); // the rule is seeded once, on the operator's wheel
      expect(repo.rules[0]?.definition.action.wheel_id).toBe(repo.wheels[0]?.wheelId);
      await service.seedDefaults({}, A);
      expect(repo.rules).toHaveLength(1);
    });

    it('seeds each tenant on its own', async () => {
      const { service, repo } = setup();
      await service.seedDefaults({}, A);
      await service.seedDefaults({}, B);
      expect(repo.wheels.map((w) => w.tenantId)).toEqual([A, B]);
      expect(repo.rules.map((r) => r.tenantId)).toEqual([A, B]);
    });
  });
});
