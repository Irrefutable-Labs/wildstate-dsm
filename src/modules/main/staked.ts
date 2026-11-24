/**
 * Staked matches, decided by the program (SoFi Amendment S22): no referee, no verdict.
 *
 * The game builds the match's setup (both players' session keys, both teams as their latest
 * published states, a nonce from both wallets and the match, and the program `P`), then asks A's
 * wallet to lock its stake and B's to lock against A's vault. Each wallet checks the setup, both
 * teams and (B) A's vault itself. Both then ready: A signs its ready, the game relays it to B, and
 * B's wallet writes the Start. A real-world ready timeout is the game's: when it runs out, the
 * wallet left waiting withdraws, and the match is void with both stakes refunded.
 *
 * Each turn, each player's choice is sealed by their own wallet (a Commit entry), and once both
 * are sealed each wallet reveals its own; the game relays every signed entry to the other wallet,
 * which checks it before it signs its next. The turn is then resolved by the same program the
 * escrow runs. Escaping is a Resign. A player whose turn timer runs out while connected has their
 * own wallet sign a pass; a player who is away freezes the match until they come back (owner
 * ruling: no clock decides a staked match). At the end the winner's wallet settles the transcript
 * at the match cell and collects both stakes.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  collectDuel, holdingsProof, lockDuel, lockedFor, playerOfWallet, publishedState, readyDuel, sessionKey, settleDuel, signEntry, walletIdentity,
  withdrawDuel, lobbyRecord, type Relayed,
} from './dsm';
import { b32, fromB32 } from '../../integrations/dsm/host';
import { anchorBytes } from '../../domain/program';
import {
  holdSetup, loadSetup, moveOf, openingOf, other, resign, resolveTurn, TURN_MS, type Match, type MatchEscrow, type Side,
} from '../../domain/match';
import { b64, commitEntry, encodeMove, encodeSetup, resignEntry, revealEntry, unb64, type Bytes, type SetupSide } from '../../domain/program';

/** How long a ready may wait on the other wallet before the waiting one withdraws (the game's own limit). */
export const READY_MS = 60_000;

/** What the match screens and the lobby are told when a staked match moves. */
export interface StakedEvents {
  /** The match moved: redraw both players' screens. */
  changed(m: Match): void;
  /** Both stakes are locked and the Start holds: open the battle. */
  started(m: Match): void;
  /** The match is void before its Start: each stake goes back. */
  voided(m: Match, why: string): void;
  /** A turn resolved: spend bag items the program used. */
  resolved(m: Match): void;
  /** The match is decided by the program. */
  decided(m: Match): void;
}

export function freshEscrow(nonce: Uint8Array): MatchEscrow {
  return {
    nonce: b32(nonce), keys: { a: null, b: null }, a: null, b: null, cell: null, ready: null, reveal: null, start: 'open',
    transcript: [], sealed: { a: null, b: null }, revealed: { a: null, b: null }, outcome: null, paid: false,
    refunded: { a: false, b: false }, problem: '',
  };
}

/** The match's nonce: both wallets and the match (its id carries the lobby's serial), hashed. */
export function matchNonce(m: Pick<Match, 'id' | 'a' | 'b'>): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wildstate/match-nonce/v1|${m.id}|${m.a.wallet}|${m.b.wallet}`).digest());
}

const online = (m: Match, side: Side) => {
  const p = playerOfWallet(m[side].wallet);
  if (!p) throw new Error(`@${m[side].name} is not in the game`);
  return p;
};

// ------------------------------------------------------------------ one task at a time per match

/** Each match's wallet requests, in order: a transcript is one sequence of indexes. */
const queues = new Map<string, Promise<void>>();
function queued(m: Match, task: () => Promise<void>): Promise<void> {
  const run = (queues.get(m.id) ?? Promise.resolve()).then(task);
  queues.set(m.id, run.catch(() => {}));
  return run;
}

/**
 * Each match's stakes moving (withdraw and refunds, or settle and collect), one run at a time: a
 * run reads what the one before it recorded. Both players coming back at once, or one page coming
 * back twice, would otherwise withdraw twice and collect each vault twice. Apart from `queues`:
 * a payout runs from inside a queued turn.
 */
const payouts = new Map<string, Promise<void>>();
function onePayout(m: Match, task: () => Promise<void>): Promise<void> {
  const run = (payouts.get(m.id) ?? Promise.resolve()).then(task);
  payouts.set(m.id, run.catch(() => {}));
  return run;
}

// ------------------------------------------------------------------ setting up and locking

/**
 * Build the setup and lock both stakes, then ready both wallets. Anything short of a Start is void:
 * a locked stake is withdrawn and goes back to its owner.
 */
export async function lockMatch(m: Match, events: StakedEvents): Promise<void> {
  const { save } = await lobbyRecord();
  const e = m.escrow!;
  try {
    const nonce = fromB32(e.nonce);
    // Each wallet names its session key and commits its start entropy for the match (SoFi S33).
    const [named, namedB] = await Promise.all((['a', 'b'] as const).map((s) => sessionKey(online(m, s), nonce)));
    e.keys = { a: b64(named.key), b: b64(namedB.key) };
    save(); events.changed(m);
    const side = async (s: Side, wallet: { key: Uint8Array; commitment: Uint8Array }): Promise<SetupSide> => {
      const id = await walletIdentity(m[s].wallet);
      return {
        genesis: id.genesis, deviceId: id.deviceId, sessionKey: wallet.key, startCommitment: wallet.commitment,
        poultice: m[s].items.poultice, tonic: m[s].items.tonic,
        team: await Promise.all(m[s].team.map((c) => publishedState(c))),
      };
    };
    const setup = encodeSetup(nonce, await side('a', named), await side('b', namedB));
    // No state before the Start: the tiebreak is derived from the entropy the Start opens.
    holdSetup(m, setup);
    save();
    // Each wallet checks the other holds its team: B proves its own for A's lock, then A (after its lock) for B's.
    const team = (s: Side) => m[s].team.map((c) => anchorBytes(c));
    const a = await lockDuel(online(m, 'a'), setup, 'a', m.stake, m.b.wallet, await holdingsProof(online(m, 'b'), team('b')));
    e.a = a.vault; e.cell = a.cell;
    save(); events.changed(m);
    const b = await lockDuel(online(m, 'b'), setup, 'b', m.stake, m.a.wallet, await holdingsProof(online(m, 'a'), team('a')), a.vault);
    if (b.cell !== a.cell) throw new Error('the two stakes are on two match cells');
    e.b = b.vault;
    save(); events.changed(m);
  } catch (err) {
    await voidMatch(m, `The stakes could not both be locked: ${message(err)}`, events);
    return;
  }
  await readyBoth(m, events);
}

/**
 * A readies and hands out its start entropy with its ready; the game relays both; B checks A's
 * entropy opens A's commitment, readies and writes the Start with both. The waiting wallet
 * withdraws if the other never readies. The program starts on both sides' entropy.
 */
async function readyBoth(m: Match, events: StakedEvents): Promise<void> {
  const { save } = await lobbyRecord();
  const e = m.escrow!;
  let waiting: Side = 'b';
  try {
    const second = await within(READY_MS, (async () => {
      if (!e.ready || !e.reveal) {
        const ready = await readyDuel(online(m, 'a'), e.cell!);
        e.ready = b64(ready.readySignature);
        e.reveal = b64(ready.reveal);
        save(); events.changed(m);
      }
      waiting = 'a';
      return readyDuel(online(m, 'b'), e.cell!, { ready: unb64(e.ready), reveal: unb64(e.reveal) });
    })());
    if (!second.started) throw new Error('B readied but no Start holds the match');
    loadSetup(m, unb64(m.program.setup), { a: unb64(e.reveal!), b: second.reveal });
  } catch (err) {
    // The wallet left waiting withdraws: no stake waits on the other side's silence.
    await voidMatch(m, `${err instanceof Timeout ? `@${m[other(waiting)].name} did not ready in time` : message(err)}`, events, waiting);
    return;
  }
  e.start = 'started';
  m.phase = 'battle';
  m.deadline = Date.now() + TURN_MS;
  save();
  events.started(m);
}

class Timeout extends Error {}
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout(`no answer in ${ms / 1000} s`)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The match is void before its Start: a side with a stake withdraws (`by` first, else whichever
 * locked and is here), and each stake goes back to its own owner. A Start that won the race is
 * not void: the match is played, and the players are never told it was void (phones,
 * 2026-10-08: a ready that ran past its window announced a void, the Start had already landed,
 * the match was played and won, and the void notice stayed on both lobbies).
 */
async function voidMatch(m: Match, why: string, events: StakedEvents, by?: Side): Promise<void> {
  const { save } = await lobbyRecord();
  const e = m.escrow!;
  e.problem = `Match void. ${why}`;
  m.phase = 'void';
  save();
  await withdrawAndRefund(m, events, by);
  if (e.start !== 'started') events.voided(m, why);
}

/** Withdraw (once a stake is locked), then each side's stake back to its own wallet, each as soon as that wallet is here. */
export function withdrawAndRefund(m: Match, events: StakedEvents, by?: Side): Promise<void> {
  return onePayout(m, () => refund(m, events, by));
}
async function refund(m: Match, events: StakedEvents, by?: Side): Promise<void> {
  const { save } = await lobbyRecord();
  const e = m.escrow!;
  if (e.cell && e.start === 'open') {
    const order = by ? [by, other(by)] : (['a', 'b'] as const);
    for (const s of order) {
      if (!e[s] || !playerOfWallet(m[s].wallet)) continue;
      try {
        e.start = await withdrawDuel(online(m, s), e.cell);
        save();
        break;
      } catch (err) {
        e.problem = `${e.problem} Withdrawing: ${message(err)}`;
        save();
      }
    }
  }
  if (e.start === 'started') {
    // The Start reached the cell first: the match is on, and is played.
    m.phase = 'battle';
    m.deadline = Date.now() + TURN_MS;
    e.problem = '';
    save();
    events.started(m);
    return;
  }
  if (e.start !== 'withdrawn') return;
  await Promise.all((['a', 'b'] as const).map(async (s) => {
    const vault = e[s];
    if (!vault || e.refunded[s] || !playerOfWallet(m[s].wallet)) return;
    try {
      await collectDuel(online(m, s), [vault], 'Stake returned');
      e.refunded[s] = true;
      save(); events.changed(m);
    } catch (err) {
      e.problem = `${e.problem} Returning a stake: ${message(err)}`;
      save();
    }
  }));
}

/** A lock that landed after its match gave up on it, found and recorded so the stake goes back. */
export async function findLateLock(m: Match, side: Side): Promise<void> {
  const e = m.escrow!;
  if (e[side] || !m.program.setup) return;
  const found = await lockedFor(m[side].wallet, unb64(m.program.setup));
  if (!found) return;
  e[side] = found.vault;
  e.cell ??= found.cell;
}

// ------------------------------------------------------------------ playing

/** The entries `side`'s wallet has not applied: every one after its own last. */
function unseen(e: MatchEscrow, side: Side): Relayed[] {
  let last = -1;
  e.transcript.forEach((x, i) => { if (x.side === side) last = i; });
  return e.transcript.slice(last + 1).map((x) => ({ entry: unb64(x.entry), signature: unb64(x.signature) }));
}

/** `side`'s wallet signs `entry`, the transcript's next. */
async function sign(m: Match, side: Side, entry: (index: number) => Bytes): Promise<void> {
  const { save } = await lobbyRecord();
  const e = m.escrow!;
  const index = e.transcript.length + 1;
  const bytes = entry(index);
  const signed = await signEntry(online(m, side), e.cell!, unseen(e, side), bytes);
  if (signed.index !== index) throw new Error(`the wallet signed entry ${signed.index} where ${index} was next`);
  e.transcript.push({ side, entry: b64(bytes), signature: b64(signed.signature) });
  save();
}

/**
 * `side` chose this turn's move: its wallet seals it, and once both are sealed each wallet reveals
 * its own and the program resolves the turn. Refused choices never reach a wallet.
 */
export function chooseStaked(m: Match, side: Side, choice: string, events: StakedEvents): string | null {
  if (m.phase !== 'battle') return 'match-over';
  if (m[side].choice !== null) return 'already-chosen';
  const mv = choice === 'pass' ? { kind: 'pass' as const } : moveOf(m, side, choice);
  if (typeof mv === 'string') return mv;
  m[side].choice = choice;
  void advance(m, events);
  return null;
}

/**
 * Everything that can happen next, in order: seal each chosen move, reveal both once both are
 * sealed, resolve the turn. A wallet that is away stops it there; it goes on when they are back.
 */
export function advance(m: Match, events: StakedEvents): Promise<void> {
  return queued(m, async () => {
    const { save } = await lobbyRecord();
    const e = m.escrow!;
    try {
      for (;;) {
        if (m.phase !== 'battle') return;
        const toSeal = (['a', 'b'] as const).find((s) => m[s].choice !== null && !e.sealed[s] && playerOfWallet(m[s].wallet));
        if (toSeal) {
          const salt: Uint8Array<ArrayBuffer> = new Uint8Array(randomBytes(32));
          const opening = openingOf(m, toSeal);
          await sign(m, toSeal, (i) => commitEntry(i, toSeal, salt, opening));
          e.sealed[toSeal] = { salt: b64(salt), opening: b64(opening) };
          save(); events.changed(m);
          continue;
        }
        if (!e.sealed.a || !e.sealed.b) return;
        const toReveal = (['a', 'b'] as const).find((s) => !e.revealed[s]);
        if (toReveal) {
          if (!playerOfWallet(m[toReveal].wallet)) return;
          const sealed = e.sealed[toReveal]!;
          await sign(m, toReveal, (i) => revealEntry(i, toReveal, unb64(sealed.salt), unb64(sealed.opening)));
          e.revealed[toReveal] = sealed.opening;
          save(); events.changed(m);
          continue;
        }
        const log = resolveTurn(m, unb64(e.revealed.a!), unb64(e.revealed.b!), Date.now());
        e.sealed = { a: null, b: null };
        e.revealed = { a: null, b: null };
        e.problem = '';
        save();
        events.resolved(m);
        events.changed(m);
        if (log.end) { events.decided(m); await payOut(m, events); return; }
      }
    } catch (err) {
      e.problem = `A move could not be signed: ${message(err)}`;
      save(); events.changed(m);
    }
  });
}

/**
 * `side` resigns: its own wallet signs a Resign, and the program gives the other side the win. The
 * other side's move of this turn counts only if it was revealed, as the escrow reads it.
 */
export function resignStaked(m: Match, side: Side, events: StakedEvents): Promise<void> {
  return queued(m, async () => {
    if (m.phase !== 'battle') return;
    const { save } = await lobbyRecord();
    const e = m.escrow!;
    try {
      await sign(m, side, (i) => resignEntry(i, side));
    } catch (err) {
      e.problem = `The resignation could not be signed: ${message(err)}`;
      save(); events.changed(m);
      return;
    }
    const theirs = e.revealed[other(side)];
    resign(m, side, Date.now(), theirs ? unb64(theirs) : encodeMove({ kind: 'pass' }));
    e.sealed = { a: null, b: null };
    e.revealed = { a: null, b: null };
    save();
    events.changed(m);
    events.decided(m);
    await payOut(m, events);
  });
}

/** The turn timer ran out (the game's own limit): a player who is here and has not chosen has their own wallet seal a pass. */
export function passIfDue(m: Match, now: number, events: StakedEvents): void {
  if (m.phase !== 'battle' || now < m.deadline) return;
  for (const s of ['a', 'b'] as const) {
    if (m[s].choice !== null || !playerOfWallet(m[s].wallet)) continue;
    m[s].choice = 'pass';
  }
  m.deadline = now + TURN_MS;
  void advance(m, events);
}

// ------------------------------------------------------------------ settling

/**
 * The match is decided: the winner's wallet writes the transcript to the match cell (one write for
 * the whole match) and collects both stakes, once the account read the outcome there. A winner who
 * is away settles and collects when they are back.
 */
export function payOut(m: Match, events: StakedEvents): Promise<void> {
  return onePayout(m, () => pay(m, events));
}
async function pay(m: Match, events: StakedEvents): Promise<void> {
  const { save } = await lobbyRecord();
  const e = m.escrow!;
  if (m.phase !== 'done' || m.winner === null) return;
  const winner = m.winner;
  if (!playerOfWallet(m[winner].wallet)) return;
  try {
    if (!e.outcome) {
      const outcome = await settleDuel(online(m, winner), e.cell!, unseen(e, winner));
      if (outcome !== `${winner}-wins`) throw new Error(`the match cell holds ${outcome || 'nothing'}, not ${winner}-wins`);
      e.outcome = `${winner}-wins`;
      save(); events.changed(m);
    }
    if (!e.paid) {
      await collectDuel(online(m, winner), [e.a!, e.b!], 'Winnings collected');
      e.paid = true;
      e.problem = '';
      save(); events.changed(m);
    }
  } catch (err) {
    e.problem = `Settling the stakes: ${message(err)}`;
    save(); events.changed(m);
  }
}
