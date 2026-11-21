import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdapterConfig, TransportRequest, TransportResponse } from './adapter';

export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * One call to a casino through the injected transport. Never throws: a timeout, a transport error
 * or anything else that stops us learning the outcome is `undefined`, which the adapters map to
 * `unknown` (the casino may or may not have acted, so it is never a failure).
 */
export async function callCasino(
  config: AdapterConfig,
  req: TransportRequest,
): Promise<TransportResponse | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    return await Promise.race([config.transport(req), timeout]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;

export function requestHeaders(config: AdapterConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const hmacHex = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;

/** Constant-time comparison of two lower-case hex SHA-256 digests; anything malformed is false. */
export function macMatches(given: string, expected: string): boolean {
  if (!HEX64.test(given) || !HEX64.test(expected)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

export const sandboxMismatch = (config: AdapterConfig, requestSandbox: boolean): boolean =>
  (config.sandbox ?? false) !== requestSandbox;
