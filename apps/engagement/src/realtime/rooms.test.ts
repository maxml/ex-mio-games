import { roomName, roomOf } from './rooms';

/*
 * D-30, F8: realtime is per environment. The environment is part of every room name, so a sandbox
 * player's room and a production player's room are never the same room.
 * Mutation: drop the environment segment from `roomName` -> both tests red.
 */
const T = '0190a1b2-c3d4-4e5f-8a6b-000000000001';
const P = '0190a1b2-c3d4-4e5f-8a6b-0000000000a1';

describe('realtime rooms are per environment (D-30)', () => {
  it('the same player in sandbox and in production is in two different rooms', () => {
    expect(roomName(T, true, 'player', P)).not.toBe(roomName(T, false, 'player', P));
  });

  it('a redeemed principal is placed in the room of its own environment', () => {
    const base = { sub: P, tid: T, roles: ['player' as const] };
    expect(roomOf({ ...base, sandbox: true })).toBe(roomName(T, true, 'player', P));
    expect(roomOf({ ...base, sandbox: false })).toBe(roomName(T, false, 'player', P));
  });
});
