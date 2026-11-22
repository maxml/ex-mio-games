// Single source of truth for turning the `CORS_ORIGIN` env string into the shape
// the HTTP (`enableCors`) and socket.io (`io-adapter`) layers consume — and the
// shape the production config guard inspects. Keeping the parsing here stops the
// three call sites from drifting (e.g. one treating a `*` inside a list as
// allow-any while another rejects it).

/**
 * Parse a `CORS_ORIGIN` value.
 *
 * - A lone `*` (the dev convenience) returns the literal `'*'`, which callers map
 *   to "reflect any origin".
 * - Anything else is split on commas, trimmed, and emptied entries dropped,
 *   returning the explicit allow-list as an array.
 *
 * A `*` that appears as one element of a list is NOT collapsed to `'*'`: it stays
 * in the returned array so the production guard can reject the list outright
 * (e.g. `https://app.example.com,*`) instead of silently allowing any origin.
 */
export function parseCorsOrigins(value: string): '*' | string[] {
  const entries = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (entries.length === 1 && entries[0] === '*') {
    return '*';
  }
  return entries;
}

/**
 * True when the parsed `CORS_ORIGIN` would allow ANY origin — either a lone `*`
 * or a list that still contains a `*` element. Used by the production guard to
 * forbid wildcard CORS while credentials are enabled.
 */
export function corsAllowsAnyOrigin(value: string): boolean {
  const parsed = parseCorsOrigins(value);
  return parsed === '*' || parsed.includes('*');
}
