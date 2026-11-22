import { ProductEventProps } from '@ex-mio/contracts';
import { createLogger } from './index';

/*
 * Fix-round re-review, coordinator question 2. The fix made log keys an allow-list and prop VALUES
 * a character allow-list, but prop KEYS stay a deny-list (a frozen test needs arbitrary keys), and
 * the log path lets `props` through with ANY key. Each probe carries a secret or PII marker that must
 * not reach the output (logs) or must be refused (props). The previous round's 11 probes stay in
 * review-final-redaction.test.ts and are re-run beside these.
 *
 * Controls (green): `email` and `phone` keys are refused; a phone in a known key is refused.
 * RED at dd9d464 (each names its hole):
 *  PROPS-K1 a phone in a key the deny-list does not know (`contact_number`, 7 digits).
 *  PROPS-K2 a phone as a NUMBER value: the digit-run rule reads strings only.
 *  PROPS-K3 a bearer JWT with no comma: every character is on the value allow-list.
 *  PROPS-K4 an opaque API secret (`sk_live_...`): same.
 *  LOG-K1 `props` on an ordinary log line: any key passes, and `api_key` is not scrubbed by value.
 *  LOG-K2 a child logger's bindings: pino serializes them through `formatters.bindings`, never
 *         through `formatters.log`, so the allow-list does not see them.
 *  LOG-K3 a phone number inside a message: the string scrub has no phone shape.
 * Mutation for a fix: remove the new rule -> the probe it covers goes red again.
 */

function capture() {
  const raw: string[] = [];
  const logger = createLogger({ level: 'trace' }, { write: (c: string) => void raw.push(c) });
  return { logger, text: () => raw.join('') };
}

const refused = (props: Record<string, unknown>): boolean =>
  !ProductEventProps.safeParse(props).success;

describe('fix-round re-review: props keys carrying PII (Q2)', () => {
  it('PROPS-KC control: the email and phone keys, and a long phone in any key, are refused', () => {
    expect(refused({ email: 'abc' })).toBe(true);
    expect(refused({ phone: 'abc' })).toBe(true);
    expect(refused({ note: '380501234567' })).toBe(true);
  });

  it.each([
    ['K1 a 7-digit phone under a key the deny-list does not know', { contact_number: '5012345' }],
    ['K2 a phone as a number value', { contact: 380501234567 }],
    [
      'K3 a bearer JWT with no comma',
      { note: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNlY3JldA' },
    ],
    ['K4 an opaque API secret', { note: 'sk_live_EXAMPLE_0000000000000000' }],
  ])('PROPS-%s is refused', (_name, props) => {
    expect(refused(props)).toBe(true);
  });
});

describe('fix-round re-review: log lines (Q2)', () => {
  it('LOG-K1 a secret under `props` on an ordinary log line never reaches the output', () => {
    const { logger, text } = capture();
    logger.info({ props: { api_key: 'SECRET-K1', phone: '+380501234567' } }, 'x');
    expect(text()).not.toContain('SECRET-K1');
    expect(text()).not.toContain('380501234567');
  });

  it('LOG-K2 a secret in a child logger binding never reaches the output', () => {
    const { logger, text } = capture();
    logger.child({ api_key: 'SECRET-K2' }).info('child line');
    expect(text()).toContain('child line'); // the line was written
    expect(text()).not.toContain('SECRET-K2');
  });

  it('LOG-K3 a phone number inside a message never reaches the output', () => {
    const { logger, text } = capture();
    logger.warn('player +380 50 123 45 67 asked for a callback');
    expect(text()).toContain('asked for a callback');
    expect(text()).not.toMatch(/123 45 67/);
  });
});
