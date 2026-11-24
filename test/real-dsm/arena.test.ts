/**
 * The staked arena on real DSM, end to end: the game's own code (`staked.ts`, `dsm.ts`) driving the
 * game's real account and two players' real wallets on the storage set, with nothing mocked
 * between them. `escrow-flow.test.ts` checks what the game asks each wallet and in what order,
 * against stand-ins; this suite checks that the real wallets and the real escrow do what the
 * game counts on: both stakes locked under one setup, the Start written, each move sealed and
 * revealed by its own wallet, the outcome settled at the match cell, and the stakes paid by DSM.
 *
 * Every balance here is read from the wallet's own account (`balance.list`, the number its wallet
 * screen shows), never from the game's record.
 *
 * Only the game's page is a stand-in: the RPGJS player and its screens. The game server talks to
 * a player through them; DSM never does.
 *
 * Run with `npm run test:dsm` (see `hosts.ts` for what it needs).
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpgPlayer } from '@rpgjs/server';
import { Account, runDir, until } from './hosts';
import { lockingMatch, type Match } from '../../src/domain/match';
import { SPECIES, fieldedTeam, transition, type Command, type GameState } from '../../src/domain/game';
import { WELCOME_COINS } from '../../src/integrations/dsm/terms';

type Dsm = typeof import('../../src/modules/main/dsm');
type Staked = typeof import('../../src/modules/main/staked');

/** The game's page for one player: its screens record what the game showed and do nothing else. */
class Page {
  shown = new Map<string, Record<string, unknown>>();
  state: GameState | null = null;
  constructor(readonly id: string) {}
  gui(id: string) {
    const page = this;
    return {
      on: () => {},
      open: async (data?: Record<string, unknown>) => { if (data) page.shown.set(id, { ...data }); },
      update: (data?: Record<string, unknown>) => { if (data) page.shown.set(id, { ...(page.shown.get(id) ?? {}), ...data }); },
      close: async () => {},
    };
  }
  getGui(id: string) { return this.shown.has(id) ? this.gui(id) : undefined; }
  creatureSave = Object.assign(() => (this.state ? JSON.stringify(this.state) : ''), {
    set: (saved: string) => { this.state = JSON.parse(saved) as GameState; },
  });
  isConnected() { return true; }
}
const asPlayer = (p: Page) => p as unknown as RpgPlayer;

const WILD = 'WILD';
let dir: string;
let game: Account, alice: Account, bob: Account;
let dsm: Dsm, staked: Staked;
const pages = new Map<string, Page>();
const seen: string[] = [];
const events = {
  changed: () => {},
  started: (m: Match) => seen.push(`started ${m.id}`),
  voided: (m: Match, why: string) => seen.push(`void ${m.id}: ${why}`),
  resolved: (m: Match) => seen.push(`turn ${m.id} ${m.turn}`),
  decided: (m: Match) => seen.push(`decided ${m.id} ${m.winner} by ${m.reason}`),
};

/** A player opens the game: its page shows the game's connect code, and its wallet approves it. */
async function enter(page: Page, wallet: Account): Promise<void> {
  const connected = dsm.connectWallet(asPlayer(page), (state) => { page.state = state; });
  const code = await until(`${page.id}: the game shows a connect code`, 600_000, async () => {
    const c = page.shown.get('dsm-connect')?.code;
    return typeof c === 'string' && c !== '' ? c : null;
  });
  await wallet.approve(code, 'Wildstate');
  await connected;
  expect(dsm.walletOf(asPlayer(page))).toBe(await wallet.deviceId());
}

/** The player's fielded creatures, each issued to its wallet: what a staked match locks. */
async function issuedTeam(page: Page) {
  return until(`${page.id}: its fielded creatures issued to its wallet`, 600_000, async () => {
    const s = page.state!;
    const team = fieldedTeam(s).map((id) => s.creatures.find((c) => c.id === id)!);
    return team.length > 0 && team.every((c) => c.anchor !== null) ? team : null;
  });
}

const holds = (wallet: Account, amount: bigint, what: string) =>
  until(what, 600_000, async () => {
    const n = await wallet.available(WILD);
    if (n !== amount) throw new Error(`${wallet.name} holds ${n} ${WILD}`);
    return n;
  });

/** A staked match between two connected players, as the lobby opens one. */
async function match(id: string, stake: number, a: Page, b: Page): Promise<Match> {
  const entrant = async (p: Page) => ({
    wallet: dsm.walletOf(asPlayer(p))!, name: p.id, team: await issuedTeam(p), items: p.state!.inventory,
  });
  const m = lockingMatch(id, stake, await entrant(a), await entrant(b));
  m.escrow = staked.freshEscrow(staked.matchNonce(m));
  const { matches, save } = await dsm.lobbyRecord();
  matches[id] = m;
  save();
  return m;
}

/** The first move the side's active creature can use. */
const firstMove = (m: Match, side: 'a' | 'b') => {
  const c = m[side].team[m[side].active];
  return SPECIES[c.species].moves[0].id;
};

beforeAll(async () => {
  dir = runDir('arena');
  [game, alice, bob] = await Promise.all([
    Account.start('game', dir), Account.start('alice', dir), Account.start('bob', dir),
  ]);
  // The game server's process, as `npm run dev` starts it: its account's ingress and secret, its own record.
  process.env.DSM_APP_HOST = game.ingress;
  process.env.DSM_APP_HOST_SECRET_FILE = game.secretFile;
  process.env.DSM_GAME_RECORD = join(mkdtempSync(join(dir, 'record-')), 'dsm-game.json');
  dsm = await import('../../src/modules/main/dsm');
  staked = await import('../../src/modules/main/staked');
  // A DSM task changes the game state through the reducer, as the field's `commit` does.
  dsm.useReadState((player) => pages.get(player.id)!.state!);
  dsm.useCommit((player, command: Command) => {
    const page = pages.get(player.id)!;
    const before = page.state!;
    const next = transition(before, before.revision, `${before.holder}/command/${before.revision}`, command);
    page.state = next;
    dsm.onCommitted(player, command, before, next);
    return next;
  });
  for (const [name, wallet] of [['alice', alice], ['bob', bob]] as const) {
    const page = new Page(name);
    pages.set(name, page);
    await enter(page, wallet);
  }
  // Each wallet holds its welcome coins and its starter, as its own account reads them.
  await Promise.all([
    holds(alice, WELCOME_COINS, 'alice: the welcome coins in her wallet'),
    holds(bob, WELCOME_COINS, 'bob: the welcome coins in his wallet'),
    issuedTeam(pages.get('alice')!),
    issuedTeam(pages.get('bob')!),
  ]);
}, 1_800_000);

afterAll(async () => {
  await Promise.all([game, alice, bob].filter(Boolean).map((a) => a.stop()));
  console.log(`[real-dsm] accounts, logs and the game's record: ${dir}`);
});

describe('the staked arena on real DSM', () => {
  it('locks both stakes, plays a turn sealed and revealed by each wallet, and pays the winner both stakes', async () => {
    const [A, B] = [pages.get('alice')!, pages.get('bob')!];
    const stake = 3;
    const m = await match('real/1', stake, A, B);
    await staked.lockMatch(m, events);
    expect(m.escrow!.problem).toBe('');
    expect(m).toMatchObject({ phase: 'battle', escrow: { start: 'started' } });
    expect(m.escrow!.a).not.toBeNull();
    expect(m.escrow!.b).not.toBeNull();
    // Each stake left its wallet into its own vault.
    await holds(alice, WELCOME_COINS - BigInt(stake), 'alice: her stake locked');
    await holds(bob, WELCOME_COINS - BigInt(stake), 'bob: his stake locked');

    // One turn: each wallet seals its move, then each reveals it, each entry relayed to the other wallet.
    expect(staked.chooseStaked(m, 'a', firstMove(m, 'a'), events)).toBeNull();
    expect(staked.chooseStaked(m, 'b', firstMove(m, 'b'), events)).toBeNull();
    await staked.advance(m, events);
    expect(m.escrow!.problem).toBe('');
    expect(m.escrow!.transcript.map((x) => x.side)).toEqual(['a', 'b', 'a', 'b']);

    // Alice resigns, through her own wallet. The grant does not cover it: resigning is the
    // player's to decide, so her wallet holds it until she approves it there. Then Bob's wallet
    // settles the transcript and collects both stakes.
    const resigning = staked.resignStaked(m, 'a', events);
    const asked = await alice.approvePending('her resignation', (p) => /resign/i.test(`${p.summary} ${p.reason}`));
    expect(asked.reason).toMatch(/yours to decide/);
    await resigning;
    expect(m.escrow!.problem).toBe('');
    expect(m).toMatchObject({ phase: 'done', winner: 'b', escrow: { outcome: 'b-wins', paid: true } });
    await holds(bob, WELCOME_COINS + BigInt(stake), 'bob: both stakes collected');
    await holds(alice, WELCOME_COINS - BigInt(stake), 'alice: her stake is gone');
  }, 1_800_000);

  it('is void when the second wallet cannot cover the stake: the first withdraws and gets its stake back', async () => {
    const [A, B] = [pages.get('alice')!, pages.get('bob')!];
    // Bob locks first; Alice holds less than the stake.
    const [rich, poor] = [await bob.available(WILD), await alice.available(WILD)];
    const stake = Number(poor) + 1;
    expect(BigInt(stake) <= rich).toBe(true);
    const m = await match('real/2', stake, B, A);
    await staked.lockMatch(m, events);
    expect(m.phase).toBe('void');
    expect(m.escrow!.problem).toContain('could not both be locked');
    expect(m.escrow).toMatchObject({ start: 'withdrawn', refunded: { a: true, b: false } });
    expect(m.escrow!.b).toBeNull();
    await holds(bob, rich, 'bob: his stake back');
    await holds(alice, poor, 'alice: nothing locked');
  }, 1_800_000);

  it('withdraws when a player leaves before the Start: the waiting wallet withdraws, and each stake goes back to its own wallet', async () => {
    const [A, B] = [pages.get('alice')!, pages.get('bob')!];
    const before = { alice: await alice.available(WILD), bob: await bob.available(WILD) };
    const stake = 2;
    const m = await match('real/3', stake, A, B);
    // Bob closes the game as soon as both stakes are locked, before either wallet readies.
    const leaving = {
      ...events,
      changed: (x: Match) => { if (x.escrow!.b && !x.escrow!.ready && dsm.walletOf(asPlayer(B))) dsm.leave(asPlayer(B)); },
    };
    await staked.lockMatch(m, leaving);
    expect(m.phase).toBe('void');
    expect(m.escrow).toMatchObject({ start: 'withdrawn', refunded: { a: true, b: false } });
    await holds(alice, before.alice, 'alice: her stake back');
    await holds(bob, before.bob - BigInt(stake), 'bob: his stake still in its vault while he is away');

    // Bob comes back: his page resumes its session, and his stake goes back to his wallet.
    await dsm.connectWallet(asPlayer(B), (state) => { B.state = state; });
    await staked.withdrawAndRefund(m, events);
    expect(m.escrow).toMatchObject({ refunded: { a: true, b: true } });
    await holds(bob, before.bob, 'bob: his stake back');
  }, 1_800_000);
});
