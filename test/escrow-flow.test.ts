import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockingMatch, type Match } from '../src/domain/match';
import { creatureState, b64, startCommitment } from '../src/domain/program';
import { newCreature, type Creature } from '../src/domain/game';

// The DSM side is mocked: what is checked here is what the game asks each wallet, in what order,
// what it relays between them, and what it records. Nobody decides the match but the program.
const dsm = vi.hoisted(() => ({
  online: new Set<string>(),
  matches: {} as Record<string, Match>,
  failLockFor: null as string | null,
  readyHangs: null as string | null,
  /** What a withdrawal finds on the match cell: the withdrawal, or a Start that got there first. */
  withdrawFinds: 'withdrawn' as 'withdrawn' | 'started',
  calls: [] as string[],
  signed: [] as { wallet: string; index: number; kind: number; preceding: number[] }[],
}));
const bytes32 = (text: string) => new Uint8Array(createHash('sha256').update(text).digest());
const anchorOf = (c: Creature) => bytes32(`anchor|${c.id}`);
/** Base32 Crockford of 32 bytes, as an issued creature's anchor is kept. */
const b32of = (bytes: Uint8Array) => { const a = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let out = '', buf = 0, bits = 0; for (const x of bytes) { buf = (buf << 8) | x; bits += 8; while (bits >= 5) { out += a[(buf >>> (bits - 5)) & 31]; bits -= 5; } } return bits ? out + a[(buf << (5 - bits)) & 31] : out; };
/** An entry's index and kind, from its bytes: class, schema, index u32, side, kind. */
const indexOf = (entry: Uint8Array) => new DataView(entry.buffer, entry.byteOffset).getUint32(4);
const kindOf = (entry: Uint8Array) => entry[9];
vi.mock('../src/modules/main/dsm', () => ({
  lobbyRecord: async () => ({ dir: { players: {}, usernames: {} }, matches: dsm.matches, save: () => {} }),
  playerOfWallet: (w: string) => (dsm.online.has(w) ? { id: w, getGui: () => undefined, gui: () => ({ on: vi.fn(), open: async () => {}, update: vi.fn(), close: vi.fn() }) } : null),
  walletOf: (p: { id: string }) => p.id,
  web2: vi.fn(),
  walletWaiting: () => null,
  walletIdentity: async (w: string) => ({ genesis: bytes32(`genesis|${w}`), deviceId: bytes32(`device|${w}`), signingKey: bytes32(`signing|${w}`) }),
  // A wallet names its key and commits its start entropy; it opens that entropy with its ready.
  sessionKey: vi.fn(async (p: { id: string }) => {
    dsm.calls.push(`key ${p.id}`);
    return { key: bytes32(`session|${p.id}`), commitment: startCommitment(bytes32(`entropy|${p.id}`)) };
  }),
  publishedState: vi.fn(async (c: Creature) => { dsm.calls.push(`state ${c.id}`); return creatureState(c, anchorOf(c)); }),
  holdingsProof: vi.fn(async (p: { id: string }, anchors: Uint8Array[]) => { dsm.calls.push(`prove ${p.id} ${anchors.length}`); return { proves: p.id }; }),
  lockDuel: vi.fn(async (p: { id: string }, _setup: Uint8Array, side: string, stake: number, opponent: string, theirs: { proves: string }, counterpart?: string) => {
    dsm.calls.push(`lock ${side} ${p.id} ${stake} vs ${opponent} proven by ${theirs.proves}${counterpart ? ` on ${counterpart}` : ''}`);
    if (dsm.failLockFor === p.id) throw new Error('the wallet holds too little WILD');
    return { vault: `vault-${side}`, cell: 'CELL' };
  }),
  readyDuel: vi.fn(async (p: { id: string }, cell: string, theirs?: { ready: Uint8Array; reveal: Uint8Array }) => {
    dsm.calls.push(`ready ${p.id} on ${cell}${theirs ? ` with ${new TextDecoder().decode(theirs.ready)}` : ''}`);
    if (dsm.readyHangs === p.id) return new Promise(() => {});
    return { readySignature: new TextEncoder().encode(`ready-${p.id}`), reveal: bytes32(`entropy|${p.id}`), started: theirs !== undefined };
  }),
  withdrawDuel: vi.fn(async (p: { id: string }, cell: string) => { dsm.calls.push(`withdraw ${p.id} on ${cell}`); return dsm.withdrawFinds; }),
  signEntry: vi.fn(async (p: { id: string }, _cell: string, preceding: { entry: Uint8Array }[], entry: Uint8Array) => {
    dsm.signed.push({ wallet: p.id, index: indexOf(entry), kind: kindOf(entry), preceding: preceding.map((x) => indexOf(x.entry)) });
    return { index: indexOf(entry), signature: new TextEncoder().encode(`sig-${indexOf(entry)}`) };
  }),
  settleDuel: vi.fn(async (p: { id: string }, cell: string, entries: { entry: Uint8Array }[]) => {
    dsm.calls.push(`settle ${p.id} on ${cell} with ${entries.map((x) => indexOf(x.entry)).join(',') || 'nothing'}`);
    const m = Object.values(dsm.matches)[0];
    return `${m.a.wallet === p.id ? 'a' : 'b'}-wins`;
  }),
  collectDuel: vi.fn(async (p: { id: string }, vaults: string[]) => { dsm.calls.push(`collect ${p.id} ${vaults.join('+')}`); }),
  lockedFor: vi.fn(async () => null),
}));
vi.mock('@rpgjs/server', () => ({ Components: { text: () => ({}) } }));
vi.mock('../src/modules/main/journey', () => ({ session: vi.fn() }));
vi.mock('../src/modules/main/field', () => ({ commit: vi.fn(), isFighting: () => false, setFighting: vi.fn(), setInArena: vi.fn(), setInMatch: vi.fn() }));
vi.mock('../src/modules/main/dialogue', () => ({ isSpeaking: () => false }));

import { advance, chooseStaked, freshEscrow, lockMatch, matchNonce, passIfDue, READY_MS, resignStaked, type StakedEvents } from '../src/modules/main/staked';
import { collectWhatIsOwed } from '../src/modules/main/lobby';

const A = 'A'.repeat(52), B = 'B'.repeat(52);
const seen: string[] = [];
const events: StakedEvents = {
  changed: () => {},
  started: (m) => seen.push(`started ${m.id}`),
  voided: (_m, why) => seen.push(`void ${why}`),
  resolved: (m) => seen.push(`turn ${m.turn}`),
  decided: (m) => seen.push(`decided ${m.winner} by ${m.reason}`),
};
function staked(stake = 100): Match {
  // Issued creatures: each with the anchor of its supply-one token.
  const issued = (c: Creature) => ({ ...c, anchor: b32of(anchorOf(c)) });
  const team = (w: string) => [issued(newCreature(`${w}/c0`, 'embercub', undefined, 5)), issued(newCreature(`${w}/c1`, 'tidefin', undefined, 3))];
  const m = lockingMatch('m1', stake, { wallet: A, name: 'alice', team: team(A) }, { wallet: B, name: 'bob', team: team(B) });
  m.escrow = freshEscrow(matchNonce(m));
  dsm.matches[m.id] = m;
  return m;
}
/** Waits until the match's queued wallet requests are done. */
const settled = (m: Match) => advance(m, events);
beforeEach(() => {
  dsm.online = new Set([A, B]); dsm.matches = {}; dsm.failLockFor = null; dsm.readyHangs = null; dsm.withdrawFinds = 'withdrawn'; dsm.calls = []; dsm.signed = []; seen.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('a staked match decided by the program', () => {
  it('builds the setup from both wallets\' keys and both teams\' published states, locks A then B against A\'s vault, readies both, then starts', async () => {
    const m = staked();
    await lockMatch(m, events);
    expect(dsm.calls).toEqual([
      `key ${A}`, `key ${B}`,
      `state ${A}/c0`, `state ${A}/c1`, `state ${B}/c0`, `state ${B}/c1`,
      `prove ${B} 2`, `lock a ${A} 100 vs ${B} proven by ${B}`, `prove ${A} 2`, `lock b ${B} 100 vs ${A} proven by ${A} on vault-a`,
      `ready ${A} on CELL`, `ready ${B} on CELL with ready-${A}`,
    ]);
    expect(m).toMatchObject({ phase: 'battle', escrow: { a: 'vault-a', b: 'vault-b', cell: 'CELL', start: 'started', problem: '' } });
    expect(m.program.setup).not.toBe('');
    expect(m.escrow!.keys).toEqual({ a: b64(bytes32(`session|${A}`)), b: b64(bytes32(`session|${B}`)) });
    expect(seen).toEqual(['started m1']);
  });

  it('is void when B\'s stake does not lock: A withdraws, and A\'s stake goes back', async () => {
    const m = staked();
    dsm.failLockFor = B;
    await lockMatch(m, events);
    expect(m.phase).toBe('void');
    expect(m.escrow!.problem).toContain('too little WILD');
    expect(dsm.calls.slice(-2)).toEqual([`withdraw ${A} on CELL`, `collect ${A} vault-a`]);
    expect(m.escrow).toMatchObject({ start: 'withdrawn', refunded: { a: true, b: false } });
  });

  it('withdraws when the other wallet never readies: the waiting wallet withdraws, and both stakes go back', async () => {
    vi.useFakeTimers();
    const m = staked();
    dsm.readyHangs = B;
    const locking = lockMatch(m, events);
    await vi.advanceTimersByTimeAsync(READY_MS + 1);
    await locking;
    expect(m.phase).toBe('void');
    expect(seen[0]).toContain(`@bob did not ready in time`);
    expect(dsm.calls.slice(-3)).toEqual([`withdraw ${A} on CELL`, `collect ${A} vault-a`, `collect ${B} vault-b`]);
    expect(m.escrow).toMatchObject({ start: 'withdrawn', refunded: { a: true, b: true } });
  });

  it('plays a match whose Start beat the withdrawal, and never tells the players it was void', async () => {
    // Phones, 2026-10-08: readying ran past its window, the void was announced, the withdrawal
    // found the Start already on the cell, the match was played and won, and the void notice stayed.
    vi.useFakeTimers();
    const m = staked();
    dsm.readyHangs = B;
    dsm.withdrawFinds = 'started';
    const locking = lockMatch(m, events);
    await vi.advanceTimersByTimeAsync(READY_MS + 1);
    await locking;
    expect(m.phase).toBe('battle');
    expect(m.escrow).toMatchObject({ start: 'started', problem: '' });
    expect(seen).toEqual(['started m1']);
    expect(dsm.calls.filter((c) => c.startsWith('collect'))).toEqual([]);
  });

  it('plays each turn as both wallets\' sealed moves, then both reveals, each relayed to the other wallet, and resolves it by the program', async () => {
    const m = staked();
    await lockMatch(m, events);
    expect(chooseStaked(m, 'b', 'strike', events)).toBeNull();
    expect(chooseStaked(m, 'b', 'flare', events)).toBe('already-chosen');
    await settled(m);
    expect(m.escrow!.sealed.b).not.toBeNull();
    expect(m.turn).toBe(0);
    expect(chooseStaked(m, 'a', 'flare', events)).toBeNull();
    await settled(m);
    // Commit B, commit A, reveal A, reveal B: each wallet is first given what it has not seen.
    expect(dsm.signed).toEqual([
      { wallet: B, index: 1, kind: 1, preceding: [] },
      { wallet: A, index: 2, kind: 1, preceding: [1] },
      { wallet: A, index: 3, kind: 2, preceding: [] },
      { wallet: B, index: 4, kind: 2, preceding: [2, 3] },
    ]);
    expect(m.turn).toBe(1);
    expect(m.program.turns).toHaveLength(1);
    expect(m.log.map((e) => `${e.side}:${e.move}`).sort()).toEqual(['a:flare', 'b:strike']);
    expect(m.escrow).toMatchObject({ sealed: { a: null, b: null }, revealed: { a: null, b: null } });
    expect(m.escrow!.transcript).toHaveLength(4);
  });

  it('ends on a resignation signed by the resigner\'s own wallet; the winner\'s wallet settles what it has not seen and collects both', async () => {
    const m = staked();
    await lockMatch(m, events);
    chooseStaked(m, 'a', 'strike', events);
    await settled(m);
    await resignStaked(m, 'b', events);
    expect(dsm.signed.at(-1)).toEqual({ wallet: B, index: 2, kind: 3, preceding: [1] });
    expect(m).toMatchObject({ phase: 'done', winner: 'a', reason: 'resign' });
    expect(dsm.calls.slice(-2)).toEqual([`settle ${A} on CELL with 2`, `collect ${A} vault-a+vault-b`]);
    expect(m.escrow).toMatchObject({ outcome: 'a-wins', paid: true });
    // Nobody referees: nothing but the wallets' own requests.
    expect(dsm.calls.some((c) => /decide|adjudicate|verdict/.test(c))).toBe(false);
  });

  it('keeps the winnings for a winner who is away, and settles and collects when they come back', async () => {
    const m = staked();
    await lockMatch(m, events);
    dsm.online.delete(B);
    await resignStaked(m, 'a', events);
    expect(dsm.calls.some((c) => c.startsWith('settle'))).toBe(false);
    dsm.online.add(B);
    await collectWhatIsOwed(B);
    expect(dsm.calls.slice(-2)).toEqual([`settle ${B} on CELL with 1`, `collect ${B} vault-a+vault-b`]);
    expect(m.escrow!.paid).toBe(true);
  });

  it('has a connected player\'s own wallet seal a pass when their timer runs out, and waits for one who is away', async () => {
    const m = staked();
    await lockMatch(m, events);
    dsm.online.delete(B);
    passIfDue(m, m.deadline, events);
    await settled(m);
    expect(m.a.choice).toBe('pass');
    expect(m.b.choice).toBeNull();
    expect(dsm.signed).toEqual([{ wallet: A, index: 1, kind: 1, preceding: [] }]);
    expect(m.phase).toBe('battle');
    // B is back: B's move seals, both reveal, and the turn resolves.
    dsm.online.add(B);
    chooseStaked(m, 'b', 'strike', events);
    await settled(m);
    expect(m.turn).toBe(1);
    expect(m.log.find((e) => e.side === 'a')).toMatchObject({ move: 'pass', dmg: 0 });
  });

  it('withdraws once and returns each stake once when both players of a void match come back at once', async () => {
    const m = staked();
    Object.assign(m.escrow!, { a: 'vault-a', b: 'vault-b', cell: 'CELL' });
    m.phase = 'void';
    await Promise.all([collectWhatIsOwed(A), collectWhatIsOwed(B)]);
    expect(dsm.calls.filter((c) => c.startsWith('withdraw'))).toHaveLength(1);
    expect(dsm.calls.filter((c) => c.startsWith('collect')).sort()).toEqual([`collect ${A} vault-a`, `collect ${B} vault-b`]);
    expect(m.escrow).toMatchObject({ start: 'withdrawn', refunded: { a: true, b: true }, problem: expect.not.stringContaining('Returning') });
  });

  it('settles and collects once when the winner comes back twice at once (a page that resumes and reconnects)', async () => {
    const m = staked();
    await lockMatch(m, events);
    dsm.online.delete(B);
    await resignStaked(m, 'a', events);
    dsm.online.add(B);
    await Promise.all([collectWhatIsOwed(B), collectWhatIsOwed(B)]);
    expect(dsm.calls.filter((c) => c.startsWith('settle'))).toEqual([`settle ${B} on CELL with 1`]);
    expect(dsm.calls.filter((c) => c.startsWith('collect'))).toEqual([`collect ${B} vault-a+vault-b`]);
    expect(m.escrow).toMatchObject({ outcome: 'b-wins', paid: true, problem: '' });
  });
});
