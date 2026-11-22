import { inspect } from 'node:util';
import { ProductEventProps } from '@ex-mio/contracts';
import { createLogger } from './index';

/*
 * Final review, starter cross-check item 10: both redaction choke points are DENY-lists.
 *  - Log lines: pino `redact` over ten key paths (`authorization`, `token`, ... and `*.<key>` one
 *    level deep). Values are never scanned; a key two levels deep or with another name passes.
 *  - Product-event props: a deny-list of PII key names, and of values only JSON text or an exact
 *    email. The monorepo starter's deny-list leaked on exactly these probe shapes.
 *
 * Every probe below carries a secret or PII that must not reach the output. RED at a4d97bb for
 * the probes named in each test; the controls are green and must stay green.
 * Mutation for a fix (keys or values): remove the new rule -> the probe it covers goes red.
 */

function capture() {
  const raw: string[] = [];
  const logger = createLogger({ level: 'trace' }, { write: (c: string) => void raw.push(c) });
  return { logger, text: () => raw.join('') };
}

describe('final review: log redaction (starter item 10)', () => {
  it('REDACT-C control: a top-level and one-level authorization header are redacted today', () => {
    const { logger, text } = capture();
    logger.info({ authorization: 'Bearer CTRL-1' });
    logger.info({ headers: { authorization: 'Bearer CTRL-2' } });
    expect(text()).not.toMatch(/CTRL-1|CTRL-2/);
  });

  it.each([
    ['L1 a header two levels deep', { req: { headers: { authorization: 'Bearer SECRET-L1' } } }],
    ['L2 the reward API key header', { headers: { 'x-api-key': 'SECRET-L2' } }],
    ['L3 api_key and client_secret keys', { api_key: 'SECRET-L3', client_secret: 'SECRET-L3' }],
    ['L5 a token in a URL query', { url: 'https://cb.example/x?access_token=SECRET-L5#f' }],
    [
      'L6 util.inspect output inside an error message',
      { err: new Error(`upstream: ${inspect({ authorization: 'Bearer SECRET-L6' })}`) },
    ],
  ])('REDACT-%s never reaches the line', (_name, obj) => {
    const { logger, text } = capture();
    logger.info(obj as object);
    expect(text()).not.toMatch(/SECRET-L\d/);
  });

  it('REDACT-L4 a bearer token with commas inside a message never reaches the line', () => {
    const { logger, text } = capture();
    logger.warn('casino refused: Authorization: Bearer SECRET-L4,scope=all');
    expect(text()).not.toContain('SECRET-L4');
  });
});

describe('final review: product-event props refuse PII and secrets in values (starter item 10)', () => {
  it('PROPS-C control: a plain email and util.inspect output are refused today', () => {
    expect(ProductEventProps.safeParse({ note: 'player@example.com' }).success).toBe(false);
    expect(
      ProductEventProps.safeParse({ note: inspect({ e: { email: 'player@example.com' } }) })
        .success,
    ).toBe(false);
  });

  it.each([
    ['P1 an email followed by a zero-width space', 'player@example.com​'],
    ['P2 an email followed by #', 'player@example.com#ref'],
    [
      'P3 a percent-encoded email inside a nested URL',
      'https://x.example/?next=https%3A%2F%2Fy.example%2F%3Fe%3Dplayer%2540example.com',
    ],
    ['P4 a phone number in Arabic-Indic digits', '+٣٨٠٥٠١٢٣٤٥٦٧'],
    ['P5 a bearer token with commas', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0,scope=all'],
  ])('PROPS-%s is refused', (_name, value) => {
    expect(ProductEventProps.safeParse({ note: value }).success).toBe(false);
  });
});
