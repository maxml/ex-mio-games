import { ProductEventProps } from '@ex-mio/contracts';
import { createLogger } from './index';

/*
 * Fix round 2 re-review, R3: "is it an allow-list in fact, or a longer deny-list?". The 11 probes of
 * review-final-redaction and the 7 of review-fixround-redaction are green after 124a8c5. These are
 * three new shapes the brief asked for (an IBAN, an IPv6 address, base64 JSON that carries an email),
 * each sent through both sinks, plus the PROPS-K2 case one digit shorter.
 *
 * What is an allow-list after 124a8c5: the top-level log keys, and the keys of `props` on an
 * ordinary log line. What is still a deny-list: every free-text VALUE (msg, err.message, an allowed
 * string field) is scrubbed by a list of regexes, and product-event props are a character class
 * plus a list of refused shapes. A shape nobody listed passes. The project's own contract names IP
 * addresses and IBANs as PII (PII_EXACT_KEY: ip, ipv6, iban), so the value side should refuse them too.
 *
 * Green control: an IBAN as a product-event prop is refused (the 7-digit run rule catches it).
 * RED at 6298275:
 *  FR2-P2 an IPv6 address as a prop value (every character is on SAFE_PROP_TEXT, no 7-digit run);
 *  FR2-P3 base64url JSON with an email as a prop value (shorter than the 32-char opaque-token rule);
 *  FR2-P4 a 9-digit local phone as a NUMBER (the number rule starts at 1e9, the string rule at 7 digits);
 *  FR2-L1 an IBAN in a log message (no word boundary before the digits, shorter than 32 chars);
 *  FR2-L2 an IPv6 address in a log message (no IP shape at all);
 *  FR2-L3 base64 JSON with an email in a log message.
 * Mutation for a fix: remove the new rule -> the probe it covers goes red again.
 */

function capture() {
  const raw: string[] = [];
  const logger = createLogger({ level: 'trace' }, { write: (c: string) => void raw.push(c) });
  return { logger, text: () => raw.join('') };
}

const refused = (props: Record<string, unknown>): boolean =>
  !ProductEventProps.safeParse(props).success;

const IBAN = 'DE89370400440532013000';
// The textbook `2001:db8:85a3::8a2e:370:7334` is refused as a prop only by coincidence: with the
// colons stripped it holds the 7-digit run `3707334`. Change the last group and it passes.
const IPV6 = '2001:db8:85a3::8a2e:370:abcd';
const B64_EMAIL = 'eyJlbWFpbCI6ImFAYi5jbyJ9'; // base64 of {"email":"a@b.co"}

describe('fix round 2: product-event prop values (R3)', () => {
  it('FR2-P0 control: a plain value passes, and the decoded probe would be refused', () => {
    expect(refused({ note: 'spin finished' })).toBe(false);
    expect(Buffer.from(B64_EMAIL, 'base64').toString()).toBe('{"email":"a@b.co"}');
    expect(refused({ note: '{"email":"a@b.co"}' })).toBe(true);
  });

  it('FR2-P1 an IBAN is refused', () => {
    expect(refused({ note: IBAN })).toBe(true);
  });

  // Known defect F3, backlog task MIO-210. `it.failing`: green while the probe leaks, RED once a fix
  // refuses it. Then turn it back into `it.each` (the assertion is unchanged).
  it.failing.each([
    ['P2 an IPv6 address', { peer: IPV6 }],
    ['P3 base64 JSON with an email', { note: B64_EMAIL }],
    ['P4 a 9-digit local phone as a number', { contact: 501234567 }],
  ])('FR2-%s is refused (MIO-210, expected to fail until fixed)', (_name, props) => {
    expect(refused(props)).toBe(true);
  });
});

const LOG_PROBES = [
  ['L1 an IBAN', `refund to ${IBAN} queued`, IBAN],
  ['L2 an IPv6 address', `login from ${IPV6} accepted`, IPV6],
  ['L3 base64 JSON with an email', `payload ${B64_EMAIL} rejected`, B64_EMAIL],
] as const;

describe('fix round 2: log lines (R3)', () => {
  // `it.failing` passes on ANY failure, so the "line was written" half of each probe below is pinned
  // separately and green here: the failing probe can then only fail on the marker.
  it.each(LOG_PROBES)('FR2-L0 control: the %s line is written', (_name, msg) => {
    const { logger, text } = capture();
    logger.warn(msg);
    expect(text()).toContain(msg.split(' ').pop()!);
  });

  // Known defect F3, backlog task MIO-210. `it.failing`: green while the marker leaks, RED once a fix
  // scrubs it. Then turn it back into `it.each` (the assertions are unchanged).
  it.failing.each(LOG_PROBES)(
    'FR2-%s in a message never reaches the output (MIO-210, expected to fail until fixed)',
    (_name, msg, marker) => {
      const { logger, text } = capture();
      logger.warn(msg);
      expect(text()).toContain(msg.split(' ').pop()!); // the control: the line was written
      expect(text()).not.toContain(marker);
    },
  );
});
