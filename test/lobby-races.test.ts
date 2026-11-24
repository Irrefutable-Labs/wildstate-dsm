import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, type Creature, type GameState } from '../src/domain/game';
import type { Match } from '../src/domain/match';
import { startCommitment } from '../src/domain/program';

// The lobby as players drive it, two at a time. The DSM side is mocked: what is checked is which
// matches the game makes and records, not what any wallet decides.
const dsm = vi.hoisted(() => ({
  online: new Map<string, unknown>(),
  matches: {} as Record<string, Match>,
  /** Holds the winner's settlement until the test lets it through. */
  settling: null as Promise<void> | null,
  /** The lobby's directory, kept between reads as the game's record keeps it. */
  dir: { players: {} as Record<string, unknown>, usernames: {} as Record<string, string> },
  /** What each wallet shared as its contacts. */
  contacts: new Map<string, string[]>(),

}));
const bytes32 = (text: string) => new Uint8Array(createHash('sha256').update(text).digest());
vi.mock('../src/modules/main/dsm', () => ({
  lobbyRecord: async () => ({ dir: dsm.dir, matches: dsm.matches, save: () => {} }),
  walletContacts: (w: string) => dsm.contacts.get(w) ?? [],
  refreshContacts: async () => {},
  playerOfWallet: (w: string) => dsm.online.get(w) ?? null,
  walletOf: (p: { id: string }) => p.id,
  web2: vi.fn(),
  walletWaiting: () => null,
  walletIdentity: async (w: string) => ({ genesis: bytes32(`genesis|${w}`), deviceId: bytes32(`device|${w}`), signingKey: bytes32(`signing|${w}`) }),
  sessionKey: async (p: { id: string }) => ({ key: bytes32(`session|${p.id}`), commitment: startCommitment(bytes32(`entropy|${p.id}`)) }),
  publishedState: async (c: Creature) => { const { anchorBytes, creatureState } = await import('../src/domain/program'); return creatureState(c, anchorBytes(c)); },
  holdingsProof: async () => ({}),
  lockDuel: async (_p: unknown, _setup: unknown, side: string) => ({ vault: `vault-${side}`, cell: 'CELL' }),
  readyDuel: async (p: { id: string }, _cell: string, theirs?: { ready: Uint8Array; reveal: Uint8Array }) => ({
    readySignature: new Uint8Array([1]), reveal: bytes32(`entropy|${p.id}`), started: theirs !== undefined,
  }),
  withdrawDuel: async () => 'withdrawn',
  signEntry: async (_p: unknown, _cell: string, _preceding: unknown, entry: Uint8Array) => ({ index: new DataView(entry.buffer, entry.byteOffset).getUint32(4), signature: new Uint8Array([2]) }),
  settleDuel: async (p: { id: string }) => {
    await dsm.settling;
    const m = Object.values(dsm.matches).find((x) => x.stake > 0)!;
    return `${m.a.wallet === p.id ? 'a' : 'b'}-wins`;
  },
  collectDuel: async () => {},
  lockedFor: async () => null,
}));
vi.mock('@rpgjs/server', () => ({ Components: { text: () => ({}) } }));
vi.mock('../src/modules/main/journey', () => ({ session: (p: { id: string }) => ({ read: () => states.get(p.id)! }) }));
vi.mock('../src/modules/main/field', () => ({ commit: vi.fn(), isFighting: () => false, setFighting: vi.fn(), setInArena: vi.fn(), setInMatch: vi.fn() }));
vi.mock('../src/modules/main/dialogue', () => ({ isSpeaking: () => false }));

import { openLobby } from '../src/modules/main/lobby';

const states = new Map<string, GameState>();
type Handler = (d: Record<string, unknown>) => Promise<void> | void;
/** A player whose screens record what they were last shown and what they do on an event. */
function online(wallet: string) {
  const guis = new Map<string, { handlers: Map<string, Handler>; shown: Record<string, unknown> | null; open: boolean }>();
  const gui = (name: string) => {
    let g = guis.get(name);
    if (!g) guis.set(name, (g = { handlers: new Map(), shown: null, open: false }));
    const screen = g;
    return {
      on: (event: string, f: Handler) => { screen.handlers.set(event, f); },
      open: (data: Record<string, unknown>) => { screen.open = true; screen.shown = data; return new Promise(() => {}); },
      update: (data: Record<string, unknown>) => { screen.shown = { ...screen.shown, ...data }; },
      close: () => { screen.open = false; },
    };
  };
  const player = { id: wallet, name: '', t: (k: string) => k, setComponentsTop: () => {}, gui, getGui: (name: string) => (guis.get(name)?.open ? gui(name) : undefined) };
  // Its starter long delivered: in its wallet, fit for a staked team.
  const start = initialState(wallet);
  states.set(wallet, { ...start, creatures: [{ ...start.creatures[0], anchor: wallet }] });
  dsm.online.set(wallet, player);
  /** Do `action` on this player's lobby screen. */
  const lobby = async (d: Record<string, unknown>) => { await guis.get('lobby')!.handlers.get('lobby')!(d); };
  const battle = async (d: Record<string, unknown>) => { await guis.get('creature-battle')!.handlers.get('battle')!(d); };
  const shown = () => guis.get('lobby')!.shown as { incoming: { id: string }[]; notice: string };
  return { player, lobby, battle, shown };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const live = (wallet: string) => Object.values(dsm.matches).filter((m) => (m.a.wallet === wallet || m.b.wallet === wallet) && (m.phase === 'locking' || m.phase === 'battle'));

let n = 0;
beforeEach(() => { dsm.online.clear(); dsm.matches = {}; dsm.settling = null; dsm.dir = { players: {}, usernames: {} }; dsm.contacts.clear(); n += 1; });
const wallet = (who: string) => `${who}${n}`.padEnd(52, who);

describe('friends from the wallet', () => {
  it('lists every contact the wallet shares as a friend, online or not, played here or not', async () => {
    const a = online(wallet('A'));
    online(wallet('B'));
    const never = 'NEVERPLAYED'.padEnd(52, 'N');
    // Neither picked an arena name; one never opened the game at all.
    dsm.contacts.set(wallet('A'), [wallet('B'), never, wallet('A')]);
    await openLobby(a.player as never);
    await tick();
    const friends = (a.shown() as unknown as { friends: { id: string; contact: boolean; online: boolean }[] }).friends;
    expect(friends.map((f) => [f.id, f.contact, f.online])).toEqual([
      [wallet('B'), true, true],
      [never, true, false],
    ]);
  });
});

describe('one wallet, one match', () => {
  it('a player who accepts two challenges at once is put in one match, not two', async () => {
    const [a, b, c] = ['A', 'B', 'C'].map((x) => online(wallet(x)));
    for (const p of [a, b, c]) await openLobby(p.player as never);
    await b.lobby({ action: 'challenge', to: a.player.id, stake: 0 });
    await c.lobby({ action: 'challenge', to: a.player.id, stake: 0 });
    await tick();
    const [first, second] = a.shown().incoming;
    await Promise.all([a.lobby({ action: 'accept', id: first.id }), a.lobby({ action: 'accept', id: second.id })]);
    await tick();
    expect(live(a.player.id)).toHaveLength(1);
  });

  it('a staked match settled late does not free a player who is already in their next match', async () => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((x) => online(wallet(x)));
    for (const p of [a, b, c, d]) await openLobby(p.player as never);
    // A and B play for a stake; A resigns, and B's wallet takes its time settling.
    await b.lobby({ action: 'challenge', to: a.player.id, stake: 10 });
    await tick();
    await a.lobby({ action: 'accept', id: a.shown().incoming[0].id });
    await tick();
    expect(live(a.player.id).map((m) => m.phase)).toEqual(['battle']);
    let settled = () => {};
    dsm.settling = new Promise((r) => { settled = r; });
    await a.battle({ action: 'escape' });
    await tick();
    // A goes on to a match with C while B's settlement is under way.
    await openLobby(a.player as never);
    await c.lobby({ action: 'challenge', to: a.player.id, stake: 0 });
    await tick();
    await a.lobby({ action: 'accept', id: a.shown().incoming[0].id });
    await tick();
    expect(live(a.player.id)).toHaveLength(1);
    settled();
    await tick();
    expect(Object.values(dsm.matches).find((m) => m.stake > 0)!.escrow!.paid).toBe(true);
    // A is still in the match with C: nobody can pull A into a third.
    await d.lobby({ action: 'challenge', to: a.player.id, stake: 0 });
    expect(d.shown().notice).toBe('One of you is already in a match.');
  });
});
