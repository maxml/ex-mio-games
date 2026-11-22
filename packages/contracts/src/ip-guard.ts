/*
 * F1 (SSRF on the reward API): which hosts and addresses MIO never calls on an operator's say-so.
 * Pure string work, no `node:` imports, so the same code runs in the contract (PUT time, literals
 * only) and in engagement's transport (call time, on every address a name resolves to). Neither
 * half is enough alone: a name can resolve to an internal address after the PUT.
 */

/** The four parts of an IPv4 address, or undefined when `s` is not a plain dotted quad. */
function parseV4(s: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : undefined;
}

function internalV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network", includes 0.0.0.0
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a! >= 224 // multicast, reserved, broadcast
  );
}

/** The 8 sixteen-bit groups of an IPv6 literal (no brackets, no zone), or undefined. */
function parseV6(s: string): number[] | undefined {
  let text = s.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = parseV4(tail[1]!);
    if (!v4) return undefined;
    text =
      text.slice(0, -tail[1]!.length) +
      ((v4[0]! << 8) | v4[1]!).toString(16) +
      ':' +
      ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (h: string): string[] => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

function internalV6(g: number[]): boolean {
  const embedded = (hi: number, lo: number): boolean =>
    internalV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // ::, ::1
  if (firstFiveZero && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (firstFiveZero && g[5] === 0) return embedded(g[6]!, g[7]!); // ::a.b.c.d (IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return embedded(g[6]!, g[7]!); // NAT64
  }
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g[0]! & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g[0]! & 0xffc0) === 0xfec0 || // site-local fec0::/10
    (g[0]! & 0xff00) === 0xff00 // multicast
  );
}

/**
 * True for a loopback, private, link-local, unspecified, multicast or otherwise non-public IP
 * literal. Anything that is not a parseable literal is also true (fail closed).
 */
export function isInternalAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = parseV4(bare);
  if (v4) return internalV4(v4);
  const v6 = parseV6(bare);
  return v6 ? internalV6(v6) : true;
}

/**
 * The PUT-time check on a URL's host: an IP literal is judged by `isInternalAddress` (the URL parser
 * has already turned `2130706433`, `0x7f000001` and `127.1` into dotted form), and `localhost` and
 * its subdomains are refused by name. A name that merely resolves to an internal address is caught
 * at call time, by the transport.
 */
export function isInternalHostLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const isLiteral = h.startsWith('[') || h.includes(':') || parseV4(h) !== undefined;
  return isLiteral ? isInternalAddress(h) : false;
}

/** Why a reward API base URL is refused at PUT time, or undefined when it passes. */
export function rewardApiUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme';
  if (url.username !== '' || url.password !== '') return 'credentials';
  if (isInternalHostLiteral(url.hostname)) return 'internal address';
  return undefined;
}
