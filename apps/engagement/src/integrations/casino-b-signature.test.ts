import { createHmac } from 'node:crypto';
import { createCasinoB } from './casino-b.adapter';

/**
 * Review F4: casino B's signed message must be injective.
 *
 * The reviewer's pair: {txn_id:"tx-1", customer_ref:"player.42"} and {txn_id:"tx-1.player",
 * customer_ref:"42"} produced the SAME dotted message, so one captured webhook could be replayed with
 * another txn_id (dedupe bypassed) for another player (credits for the wrong person).
 *
 * Mutation: sign `${sent_at}.${type}.${txn_id}.${customer_ref}.${amount}.${ccy}` again (or any
 * other separator-joined string) -> INV-ADAPTER-B-INJECTIVE and INV-ADAPTER-B-SIGNED-OK go red.
 * The signer below is the oracle of the amended protocol: a JSON array of the fields.
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const SECRET = 'whsec-test';
const hmac = (msg: string) => createHmac('sha256', SECRET).update(msg).digest('hex');
const SENT_AT = NOW.toISOString();
const TYPE = 'payment.completed';

type Data = { txn_id: string; customer_ref: string; amount_cents: number; ccy: string };
const dataOf = (txn_id: string, customer_ref: string): Data => ({
  txn_id,
  customer_ref,
  amount_cents: 5000,
  ccy: 'EUR',
});
const dotted = (d: Data) =>
  `${SENT_AT}.${TYPE}.${d.txn_id}.${d.customer_ref}.${d.amount_cents}.${d.ccy}`;
const canonical = (d: Data) =>
  JSON.stringify([SENT_AT, TYPE, d.txn_id, d.customer_ref, d.amount_cents, d.ccy]);
const body = (d: Data, signature: string) =>
  JSON.stringify({ type: TYPE, data: d, sent_at: SENT_AT, signature });

const adapter = () =>
  createCasinoB({
    baseUrl: 'http://casino.test',
    transport: async () => {
      throw new Error('no network');
    },
  });

const ORIGINAL = dataOf('tx-1', 'player.42');
const SHIFTED = dataOf('tx-1.player', '42'); // same dotted message as ORIGINAL

describe('casino B signature encoding (F4)', () => {
  it('the premise: the old dotted encoding really collides on the reviewer pair', () => {
    expect(dotted(ORIGINAL)).toBe(dotted(SHIFTED));
    expect(canonical(ORIGINAL)).not.toBe(canonical(SHIFTED));
  });

  it('INV-ADAPTER-B-SIGNED-OK: a webhook signed with the canonical encoding verifies', () => {
    expect(
      adapter().verifySignature(body(ORIGINAL, hmac(canonical(ORIGINAL))), {}, SECRET, NOW),
    ).toBe('valid');
  });

  it('INV-ADAPTER-B-INJECTIVE: a captured signature cannot be moved to the re-split body (txn_id and player changed)', () => {
    const a = adapter();
    const captured = hmac(canonical(ORIGINAL));
    expect(a.verifySignature(body(SHIFTED, captured), {}, SECRET, NOW)).toBe('invalid');
    // and the legacy dotted signature, valid for both bodies under the old scheme, is refused for both
    const legacy = hmac(dotted(ORIGINAL));
    expect(a.verifySignature(body(ORIGINAL, legacy), {}, SECRET, NOW)).toBe('invalid');
    expect(a.verifySignature(body(SHIFTED, legacy), {}, SECRET, NOW)).toBe('invalid');
  });

  it('INV-ADAPTER-B-INJECTIVE: moving a separator between any two adjacent fields never keeps the signature', () => {
    const a = adapter();
    const signed = body(dataOf('a.b', 'c'), hmac(canonical(dataOf('a.b', 'c'))));
    expect(a.verifySignature(signed, {}, SECRET, NOW)).toBe('valid');
    for (const [txn, ref] of [
      ['a', 'b.c'],
      ['a.b.c', ''],
      ['', 'a.b.c'],
    ] as const) {
      const moved = body(dataOf(txn, ref), hmac(canonical(dataOf('a.b', 'c'))));
      expect(a.verifySignature(moved, {}, SECRET, NOW)).not.toBe('valid');
    }
  });
});
