import type { CanonicalDepositEvent } from '@ex-mio/contracts';

// STAGE A STUB: types only, no behaviour. Specified in docs/specs/engagement-ingest.md section 3.

/** How an adapter answers "did you issue this reward?" when the casino's reply was lost. */
export type RecoveryMode = 'native_lookup' | 'idempotent_replay';

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

export interface RewardRequest {
  external_player_id: string;
  reward: { type: string; amount_minor: number; currency: string };
}

export type IssueResult =
  | { kind: 'issued'; reference: string }
  | { kind: 'rejected'; code: string } // final business rejection
  | { kind: 'pending'; reference: string } // accepted, not yet final (async casino)
  | { kind: 'unknown' }; // timeout or transport failure: the reward may or may not exist

export type RewardStatus =
  | { kind: 'issued'; reference: string }
  | { kind: 'rejected'; code: string }
  | { kind: 'pending' }
  | { kind: 'not_found' };

export interface CasinoAdapter {
  /** Pure. `now` is injected so the window is testable. Never throws. */
  verifySignature(raw: string, headers: Headers, secret: string, now: Date): SignatureVerdict;
  /** Pure. Called only after a signature verified. Never throws. */
  parseEvent(raw: string, headers: Headers): ParseResult;
  /** Never throws: timeout and transport errors are `{kind:'unknown'}`. */
  issueReward(request: RewardRequest, idempotencyKey: string): Promise<IssueResult>;
  /**
   * Looks up by OUR key, never by the casino's reference alone. `request` is the frozen request
   * the key was first used with: an `idempotent_replay` adapter re-sends it with the same key
   * (the casino returns the original result and issues nothing new); a `native_lookup` adapter
   * ignores it and returns `not_found` for a key the casino has never seen.
   */
  getRewardStatus(idempotencyKey: string, request: RewardRequest): Promise<RewardStatus>;
}

export interface AdapterConfig {
  baseUrl: string;
  transport: Transport;
  timeoutMs?: number;
  apiKey?: string;
}

export interface AdapterEntry {
  type: string; // 'casino-a' | 'casino-b' | ...
  recoveryMode: RecoveryMode;
  create(config: AdapterConfig): CasinoAdapter;
}

export interface AdapterRegistry {
  /** Throws if `recoveryMode` is missing or not one of the two modes, or the type is taken. */
  register(entry: AdapterEntry): void;
  get(type: string): AdapterEntry | undefined;
  list(): AdapterEntry[];
}
