import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Any RFC 4122/9562 UUID (tenant ids, principal ids). */
export const Uuid = z.string().regex(UUID_RE, 'must be a UUID');
export type Uuid = z.infer<typeof Uuid>;

/** A UUID version 7: time-ordered, so event ids sort roughly by creation time. */
export const Uuidv7 = z.string().regex(UUIDV7_RE, 'must be a UUIDv7');
export type Uuidv7 = z.infer<typeof Uuidv7>;

/**
 * Generate a UUIDv7 (RFC 9562): 48-bit unix-ms timestamp, then version 7, then
 * random bits. Uses the Web Crypto global (Node 20+ and browsers), so this
 * module also bundles for the web app, which a `node:crypto` import would break.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
