import { z } from 'zod';
import {
  Currency,
  INGEST_TIMESTAMP_WINDOW_SECONDS,
  type IssueResult,
  type RewardStatus,
} from '@ex-mio/contracts';
import type {
  AdapterConfig,
  AdapterEntry,
  CasinoAdapter,
  Headers,
  ParseResult,
  RewardRequest,
  SignatureVerdict,
} from './adapter';
import {
  callCasino,
  hmacHex,
  isRecord,
  joinUrl,
  macMatches,
  nonEmptyString,
  requestHeaders,
  sandboxMismatch,
} from './casino-http';

/**
 * Casino B (`casino-b`): the signature is a field of the body, the reward API is asynchronous
 * (a ticket first) and has no lookup by our key, so recovery replays the request with the same
 * key. Wire protocol: docs/specs/engagement-ingest.md section 3.
 */

export const CASINO_B = 'casino-b';
const PAYMENT_COMPLETED = 'payment.completed';

const DataB = z
  .object({
    txn_id: z.string().min(1).max(200),
    customer_ref: z.string().min(1).max(200),
    amount_cents: z.number().int().positive().safe(),
    ccy: Currency,
  })
  .strict();
const WebhookB = z
  .object({
    type: z.literal(PAYMENT_COMPLETED),
    data: DataB,
    sent_at: z.string().datetime(),
    signature: z.string().optional(),
  })
  .strict();

/** The signed message of a webhook, from the fields as they appear on the wire. */
const signedMessage = (sentAt: string, type: string, d: Record<string, unknown>): string =>
  `${sentAt}.${type}.${d.txn_id}.${d.customer_ref}.${d.amount_cents}.${d.ccy}`;

export function createCasinoB(config: AdapterConfig): CasinoAdapter {
  const reasonOf = (body: unknown, fallback: string): string =>
    isRecord(body) && nonEmptyString(body.error) ? body.error : fallback;

  /** POST the reward request; casino B answers 202 with a ticket, and the same key returns the same ticket. */
  async function sendIssue(
    request: RewardRequest,
    ourKey: string,
  ): Promise<
    { kind: 'ticket'; ticket: string } | { kind: 'rejected'; reason: string } | { kind: 'unknown' }
  > {
    const res = await callCasino(config, {
      method: 'POST',
      url: joinUrl(config.baseUrl, '/casino-b/v2/rewards'),
      headers: requestHeaders(config),
      body: {
        idempotency_key: ourKey,
        customer_ref: request.external_player_id,
        reward: {
          type: request.reward.type,
          amount_cents: request.reward.amount_minor,
          ccy: request.reward.currency,
        },
      },
    });
    if (!res) return { kind: 'unknown' };
    if (res.status === 202 && isRecord(res.body) && nonEmptyString(res.body.ticket)) {
      return { kind: 'ticket', ticket: res.body.ticket };
    }
    if (res.status === 400 || res.status === 422) {
      return { kind: 'rejected', reason: reasonOf(res.body, 'rejected') };
    }
    return { kind: 'unknown' };
  }

  async function ticketStatus(ticket: string): Promise<RewardStatus> {
    const res = await callCasino(config, {
      method: 'GET',
      url: joinUrl(config.baseUrl, `/casino-b/v2/rewards/${encodeURIComponent(ticket)}`),
      headers: requestHeaders(config),
    });
    if (!res || res.status !== 200 || !isRecord(res.body)) return { kind: 'unknown' };
    const body = res.body;
    if (body.state === 'PENDING') return { kind: 'pending', external_ref: ticket };
    if (body.state === 'DONE' && nonEmptyString(body.reward_ref)) {
      return { kind: 'issued', external_ref: body.reward_ref };
    }
    if (body.state === 'FAILED') {
      return { kind: 'rejected', reason: nonEmptyString(body.code) ? body.code : 'failed' };
    }
    return { kind: 'unknown' };
  }

  return {
    verifySignature(raw: string, _headers: Headers, secret: string, now: Date): SignatureVerdict {
      try {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return 'invalid';
        }
        if (!isRecord(body)) return 'invalid';
        const given = body.signature;
        if (given === undefined || given === '') return 'missing';
        if (typeof given !== 'string') return 'invalid';
        const { type, sent_at: sentAt, data } = body;
        if (typeof type !== 'string' || typeof sentAt !== 'string' || !isRecord(data)) {
          return 'invalid';
        }
        if (!macMatches(given, hmacHex(secret, signedMessage(sentAt, type, data)))) {
          return 'invalid';
        }
        const sentMs = Date.parse(sentAt);
        if (Number.isNaN(sentMs)) return 'invalid';
        const ageSeconds = Math.abs(now.getTime() - sentMs) / 1000;
        return ageSeconds > INGEST_TIMESTAMP_WINDOW_SECONDS ? 'stale' : 'valid';
      } catch {
        return 'invalid';
      }
    },

    parseEvent(raw: string): ParseResult {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return { kind: 'rejected', reason: 'malformed_json' };
      }
      // Any other well-formed event type (for example payment.refunded) is acknowledged and ignored.
      if (isRecord(json) && typeof json.type === 'string' && json.type !== PAYMENT_COMPLETED) {
        return { kind: 'ignored' };
      }
      const parsed = WebhookB.safeParse(json);
      if (!parsed.success) return { kind: 'rejected', reason: 'schema_invalid' };
      const b = parsed.data;
      return {
        kind: 'deposit',
        event: {
          source: CASINO_B,
          external_event_id: b.data.txn_id,
          type: 'deposit.succeeded',
          external_player_id: b.data.customer_ref,
          amount_minor: b.data.amount_cents,
          currency: b.data.ccy,
          occurred_at: new Date(b.sent_at).toISOString(),
        },
      };
    },

    async issueReward(request: RewardRequest, ourKey: string): Promise<IssueResult> {
      if (sandboxMismatch(config, request.sandbox)) {
        return { kind: 'rejected', reason: 'sandbox_mismatch' };
      }
      const sent = await sendIssue(request, ourKey);
      if (sent.kind === 'ticket') return { kind: 'pending', external_ref: sent.ticket };
      return sent;
    },

    async getRewardStatus(ourKey: string, request: RewardRequest): Promise<RewardStatus> {
      if (sandboxMismatch(config, request.sandbox)) {
        return { kind: 'rejected', reason: 'sandbox_mismatch' };
      }
      // No lookup by our key: replay the frozen request with the same key. The casino returns the
      // original ticket and issues nothing new; the ticket then tells the state.
      const replayed = await sendIssue(request, ourKey);
      if (replayed.kind !== 'ticket') return replayed;
      return ticketStatus(replayed.ticket);
    },
  };
}

/** Asynchronous casino, recovery by replay; settles slowly, so its deadline is a day. */
export const casinoBEntry: AdapterEntry = {
  type: CASINO_B,
  recoveryMode: 'idempotent_replay',
  issueDeadlineMs: 24 * 60 * 60 * 1000,
  create: createCasinoB,
};
