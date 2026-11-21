import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every depth, so two requests that differ only
 * in key order or whitespace hash the same. `undefined` properties are dropped,
 * as JSON.stringify would drop them.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function requestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}
