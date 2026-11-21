import { Injectable } from '@nestjs/common';
import {
  createEvent,
  DepositConfirmedV1,
  parseEvent,
  uuidv7,
  type CanonicalDepositEvent,
  type EventEnvelope,
} from '@ex-mio/contracts';
import { Db, type Tx } from '@ex-mio/service-kit';
import { RulesRepository, SpinCreditsRepository, type NewCredit } from '../model/repositories';
import { evaluateRules } from './rules.engine';

const DEPOSIT_CONFIRMED = 'engagement.deposit.confirmed';

/**
 * Grants spin credits from `engagement.deposit.confirmed` (spec section 7). It runs inside the inbox
 * transaction, so a redelivered message never reaches it, and every write below uses that `tx`.
 * X-1 / D-12: `user_id` is the event's internal `player_id`, which ingest resolved through identity
 * before the outbox write; this consumer never sees the casino's raw id and never asks identity.
 * X-3 / D-13: a deposit event marked `sandbox` grants sandbox credits and sandbox `spin.granted` events.
 */
@Injectable()
export class SpinCreditsService {
  constructor(
    private readonly db: Db,
    private readonly rules: RulesRepository,
    private readonly credits: SpinCreditsRepository,
  ) {}

  /** Throws on an event that is not a valid deposit.confirmed: the inbox parks it in the DLQ. */
  async onDepositConfirmed(tx: Tx, raw: EventEnvelope): Promise<void> {
    const event = parseEvent(raw);
    if (event.type !== DEPOSIT_CONFIRMED) {
      throw new Error(`unexpected event type ${event.type}`);
    }
    const deposit = DepositConfirmedV1.parse(event.payload);
    const tenantId = event.tenant_id;

    const userId = deposit.player_id;
    const sandbox = event.sandbox === true;
    const canonical: Omit<CanonicalDepositEvent, 'external_player_id'> = {
      tenant_id: tenantId,
      source: deposit.source,
      external_event_id: deposit.external_event_id,
      type: 'deposit.succeeded',
      amount_minor: deposit.amount_minor,
      currency: deposit.currency,
      occurred_at: deposit.occurred_at,
    };
    const [rules, prior] = await Promise.all([
      this.rules.listRules(tx),
      this.rules.priorGrantCounts(tx, userId),
    ]);
    const grants = evaluateRules(rules, canonical, prior);

    const rows: NewCredit[] = grants.flatMap((g) =>
      Array.from({ length: g.spins }, (_, seq) => ({
        id: uuidv7(),
        tenantId,
        userId,
        wheelId: g.wheel_id,
        sourceEventId: deposit.inbound_event_id,
        ruleId: g.rule_id,
        ruleVersion: g.rule_version,
        seq,
        ...(sandbox ? { sandbox: true } : {}),
      })),
    );
    if (rows.length === 0) return;

    // ON CONFLICT DO NOTHING RETURNING: only rows that were really inserted get an event.
    const inserted = await this.credits.grant(tx, rows);
    for (const credit of inserted) {
      await this.db.publish(
        tx,
        createEvent({
          type: 'engagement.spin.granted',
          tenantId,
          ...(sandbox ? { sandbox: true } : {}),
          correlationId: event.correlation_id,
          causationId: event.event_id,
          payload: {
            credit_id: credit.id,
            player_id: credit.userId,
            wheel_id: credit.wheelId,
            source_event_id: credit.sourceEventId,
          },
        }),
      );
    }
  }
}
