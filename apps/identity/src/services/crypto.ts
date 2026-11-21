import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Secrets at rest: AES-256-GCM under a key derived from CREDENTIALS_KEK. Format `iv.tag.data` (base64url). */
const keyOf = (kek: string): Buffer => createHash('sha256').update(`ex-mio-kek:${kek}`).digest();

export function encryptSecret(plain: string, kek: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(kek), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(sealed: string, kek: string): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data) throw new Error('malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(kek), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 24): string => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison (hashes both sides first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const hmacHex = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('hex');

export const hmacB64Url = (secret: string, data: string): Buffer =>
  createHmac('sha256', secret).update(data).digest();

/** A tenant id without dashes: the routing prefix of key ids and api keys. */
export const compactUuid = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();

export function expandUuid(hex: string): string | undefined {
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
