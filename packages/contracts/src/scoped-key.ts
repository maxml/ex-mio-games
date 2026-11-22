/*
 * D-26 INV-ENV-KEYS: the ONE place that builds a dedupe, idempotency, inbox, lock or order key.
 * The environment is a required boolean, so a key cannot be built without it and sandbox and
 * production never share one.
 *
 * Shape: `<kind>:<tenant>:<sbx|prd>:<part>[:<part>...]`. Parts escape `%`, `:` and `|`, so the key is
 * injective in its parts. A key with one UUID part is at most 11 + 36 + 3 + 36 + 3 = 89 characters,
 * inside the 8..128 Idempotency-Key bound.
 */

export const SCOPED_KEY_KINDS = [
  'spin',
  'deposit',
  'order',
  'hold',
  'capture',
  'release',
  'refund',
  'redeem',
  'usage',
  'inbox',
  'idempotency',
  'flight',
] as const;
export type ScopedKeyKind = (typeof SCOPED_KEY_KINDS)[number];

export interface ScopedKeyInput {
  kind: ScopedKeyKind;
  tenantId: string;
  sandbox: boolean;
  parts: readonly string[];
}

const TENANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LENGTH = 512;

const escapePart = (part: string): string =>
  part.replace(/[%:|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * F4: the one scopedKey failure that client input can cause (escaping triples `:`, `|` and `%`, so a
 * 200-character Idempotency-Key can exceed the bound). A caller that passes client text maps it to
 * a 4xx; every other scopedKey error is a programming error.
 */
export class ScopedKeyTooLong extends Error {
  constructor() {
    super('scopedKey: the key is too long');
    this.name = 'ScopedKeyTooLong';
  }
}

export function scopedKey(input: ScopedKeyInput): string {
  const { kind, tenantId, sandbox, parts } = input;
  if (!(SCOPED_KEY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`scopedKey: unknown kind "${String(kind)}"`);
  }
  if (typeof sandbox !== 'boolean') {
    throw new Error('scopedKey: sandbox is required and must be a boolean');
  }
  if (typeof tenantId !== 'string' || !TENANT_RE.test(tenantId)) {
    throw new Error('scopedKey: tenantId must be a UUID');
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('scopedKey: at least one part is required');
  }
  for (const p of parts) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('scopedKey: every part must be a non-empty string');
    }
  }
  const key = [
    kind,
    tenantId.toLowerCase(),
    sandbox ? 'sbx' : 'prd',
    ...parts.map(escapePart),
  ].join(':');
  if (key.length > MAX_LENGTH) throw new ScopedKeyTooLong();
  return key;
}
