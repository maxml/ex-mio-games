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
  sanitizeReason,
  usableSecret,
} from './casino-http';

/**
 * Casino A (`casino-a`): signed JSON webhook, synchronous reward API, native lookup by our key.
 * Wire protocol: docs/specs/engagement-ingest.md section 3.
 */

export const CASINO_A = 'casino-a';

const WebhookA = z
  .object({
    eventId: z.string().min(1).max(200),
    playerId: z.string().min(1).max(200),
    amount: z.object({ value: z.number().int().positive().safe(), currency: Currency }).strict(),
    status: z.string().min(1),
    ts: z.number().int().nonnegative().safe(),
  })
  .strict();

const TS_RE = /^\d{1,12}$/;

export function createCasinoA(config: AdapterConfig): CasinoAdapter {
  const reasonOf = (body: unknown, fallback: string): string =>
    isRecord(body) && nonEmptyString(body.error) ? sanitizeReason(body.error, fallback) : fallback;

  return {
    verifySignature(raw: string, headers: Headers, secret: string, now: Date): SignatureVerdict {
      try {
        if (!usableSecret(secret)) return 'invalid';
        const given = headers['x-a-signature'];
        if (!given) return 'missing';
        const ts = headers['x-a-timestamp'];
        if (ts === undefined || !TS_RE.test(ts)) return 'invalid';
        if (!macMatches(given, hmacHex(secret, `${ts}.${raw}`))) return 'invalid';
        // The MAC is valid: only now does the age matter (an invalid MAC always wins over stale).
        const ageSeconds = Math.abs(now.getTime() / 1000 - Number(ts));
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
      const parsed = WebhookA.safeParse(json);
      if (!parsed.success) return { kind: 'rejected', reason: 'schema_invalid' };
      const b = parsed.data;
      if (b.status !== 'SUCCESS') return { kind: 'ignored' };
      return {
        kind: 'deposit',
        event: {
          source: CASINO_A,
          external_event_id: b.eventId,
          type: 'deposit.succeeded',
          external_player_id: b.playerId,
          amount_minor: b.amount.value,
          currency: b.amount.currency,
          occurred_at: new Date(b.ts * 1000).toISOString(),
        },
      };
    },

    async issueReward(request: RewardRequest, ourKey: string): Promise<IssueResult> {
      if (sandboxMismatch(config, request.sandbox)) {
        return { kind: 'rejected', reason: 'sandbox_mismatch' };
      }
      const res = await callCasino(config, {
        method: 'POST',
        url: joinUrl(config.baseUrl, '/casino-a/bonuses'),
        headers: requestHeaders(config),
        body: {
          idempotencyKey: ourKey,
          playerId: request.external_player_id,
          bonus: {
            type: request.reward.type,
            amount: request.reward.amount_minor,
            currency: request.reward.currency,
          },
        },
      });
      if (!res) return { kind: 'unknown' };
      if (res.status === 200 && isRecord(res.body) && nonEmptyString(res.body.bonusId)) {
        return { kind: 'issued', external_ref: res.body.bonusId };
      }
      // 400/422: the casino refused this request for good. Everything else (5xx, 401, 429,
      // an odd 200) leaves the outcome unknown: never a failure, never a refund.
      if (res.status === 400 || res.status === 422) {
        return { kind: 'rejected', reason: reasonOf(res.body, 'rejected') };
      }
      return { kind: 'unknown' };
    },

    async getRewardStatus(ourKey: string, request: RewardRequest): Promise<RewardStatus> {
      if (sandboxMismatch(config, request.sandbox)) {
        return { kind: 'rejected', reason: 'sandbox_mismatch' };
      }
      const res = await callCasino(config, {
        method: 'GET',
        url: joinUrl(
          config.baseUrl,
          `/casino-a/bonuses?idempotencyKey=${encodeURIComponent(ourKey)}`,
        ),
        headers: requestHeaders(config),
      });
      if (!res) return { kind: 'unknown' };
      if (res.status === 200 && isRecord(res.body) && nonEmptyString(res.body.bonusId)) {
        return { kind: 'issued', external_ref: res.body.bonusId };
      }
      if (res.status === 404) return { kind: 'not_found' };
      return { kind: 'unknown' };
    },
  };
}

/** Synchronous casino with a lookup by our key; the deadline is its default (15 minutes). */
export const casinoAEntry: AdapterEntry = {
  type: CASINO_A,
  recoveryMode: 'native_lookup',
  issueDeadlineMs: 15 * 60 * 1000,
  create: createCasinoA,
};
