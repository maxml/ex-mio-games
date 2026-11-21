import type { Tx } from '@ex-mio/service-kit';

/**
 * Named places where a test can make the code fail, to prove that a failure rolls everything back
 * together. Each point is called AFTER the write it is named for, INSIDE that write's transaction
 * (spec section 5):
 *  - `after_inbox`: first thing in the inbox handler, after the consumer's inbox insert;
 *  - `after_journal`: journal row and legs written;
 *  - `after_balance`: balance updates (and the reserve state change) done;
 *  - `after_outbox`: the event is enqueued;
 *  - `webhook_apply`: the dedupe row and the subscription change are written;
 *  - `after_usage_report_sent`: the provider call returned, our record is not inserted yet;
 *  - `reconciliation_scan`: inside the scan.
 */
export const FAULT_POINTS = [
  'after_inbox',
  'after_journal',
  'after_balance',
  'after_outbox',
  'webhook_apply',
  'after_usage_report_sent',
  'reconciliation_scan',
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface LedgerFaults {
  hit(point: FaultPoint, tx?: Tx): Promise<void>;
}

export const LEDGER_FAULTS = Symbol('LEDGER_FAULTS');

/** The production implementation: does nothing. */
export const NO_FAULTS: LedgerFaults = {
  async hit(): Promise<void> {
    /* no-op */
  },
};
