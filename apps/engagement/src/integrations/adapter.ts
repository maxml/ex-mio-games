import type { CanonicalDepositEvent, CasinoRewardPort } from '@ex-mio/contracts';

// STAGE A STUB: types only, no behaviour. Specified in docs/specs/engagement-ingest.md section 3.

/** How an adapter answers "did you issue this reward?" when the casino's reply was lost. */
export type { RecoveryMode } from '@ex-mio/contracts';
import type { RecoveryMode } from '@ex-mio/contracts';

export type Headers = Record<string, string | undefined>;

export interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}
export interface TransportResponse {
  status: number;
  body: unknown;
}
/** The only way an adapter reaches a casino. A test transport can drop or delay replies. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** `valid` only when the MAC matches AND the timestamp is inside the window. */
export type SignatureVerdict = 'valid' | 'missing' | 'invalid' | 'stale';

export type ParseResult =
  | { kind: 'deposit'; event: Omit<CanonicalDepositEvent, 'tenant_id'> }
  | { kind: 'ignored' } // a well-formed event we do not act on (unknown type, status not successful)
  | { kind: 'rejected'; reason: 'malformed_json' | 'schema_invalid' };

// The reward side (RewardRequest, IssueResult, RewardStatus, CasinoRewardPort) is the single port in
// packages/contracts/src/casino-adapter.ts (decision D-2). Re-exported here for the adapters' imports.
export type { IssueResult, RewardRequest, RewardStatus } from '@ex-mio/contracts';

export interface CasinoAdapter extends CasinoRewardPort {
  /** Pure. `now` is injected so the window is testable. Never throws. */
  verifySignature(raw: string, headers: Headers, secret: string, now: Date): SignatureVerdict;
  /** Pure. Called only after a signature verified. Never throws. */
  parseEvent(raw: string, headers: Headers): ParseResult;
  // issueReward and getRewardStatus come from CasinoRewardPort. Neither throws: timeout and
  // transport errors are `{kind:'unknown'}`, for the status lookup as well. An `idempotent_replay`
  // adapter re-sends the frozen request with the same key; a `native_lookup` adapter ignores it and
  // returns `not_found` for a key the casino has never seen.
}

export interface AdapterConfig {
  baseUrl: string;
  transport: Transport;
  timeoutMs?: number;
  apiKey?: string;
  /**
   * D-12: the environment this instance talks to. A request whose `sandbox` differs is answered
   * `rejected` before any I/O. Defaults to `false` (production).
   */
  sandbox?: boolean;
}

export interface AdapterEntry {
  type: string; // 'casino-a' | 'casino-b' | ...
  recoveryMode: RecoveryMode;
  /** D-12: default issue deadline of this casino type (IssueDeadlineMs bounds); a tenant may override it. */
  issueDeadlineMs: number;
  create(config: AdapterConfig): CasinoAdapter;
}

export interface AdapterRegistry {
  /** Throws if `recoveryMode` is missing or not one of the two modes, `issueDeadlineMs` is out of bounds, or the type is taken. */
  register(entry: AdapterEntry): void;
  get(type: string): AdapterEntry | undefined;
  list(): AdapterEntry[];
}
