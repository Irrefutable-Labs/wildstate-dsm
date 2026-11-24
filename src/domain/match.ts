/**
 * A player-vs-player match: two teams of up to three, one creature out at a time, whoever knocks
 * out all of the other side's creatures wins. Both players choose a move each turn without seeing
 * the other's; the turn resolves once both are in.
 *
 * Every turn is resolved by the staked-match program (src/domain/program.ts: DSM's
 * `wildstate-duel`, compiled to WebAssembly), free matches and staked ones alike, so what a screen
 * shows is exactly what a staked match settles. The match keeps the setup's bytes, the program's state
 * after the last turn and every turn's openings; the teams, log and events here are views of
 * those for the screens. Each team is a snapshot of the creatures as the player prepared them
 * (HP and charges, so healing and charging beforehand matters); the match never writes back to
 * the players' own creatures.
 *
 * The program's rules: a level tie's first actor comes from the tiebreak seed, a move the rules
 * cannot play (or bytes that are no move) is a pass, Resign hands the other side the win, and
 * after 60 turns more team HP wins, equal HP going to the seed. There is never a tie. The seed is
 * derived from both sides' start entropy, committed in the setup and opened by the Start.
 */
import type { ExchangeEntry } from './duel';
import { ITEMS, SPECIES, type Creature, type UsableItem } from './game';
import {
  ITEM_IDS, b64, encodeMove, playTurn, startState, stateView, unb64,
  type End, type LogView, type MoveView, type Reveals, type Side, type StateView,
} from './program';

export type { Side } from './program';
export const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
/** Seconds a player has to choose each turn, a real-world limit of the game's (never DSM's). */
export const TURN_MS = 30_000;
/** A free match: three missed turns in a row resign the player who missed them. */
export const MISSES_TO_FORFEIT = 3;

export interface MatchSide {
  wallet: string;
  name: string;
  /** The team as the program's state has it after the last turn (a view for the screens). */
  team: Creature[];
  active: number;
  ko: number;
  /** A move id, `item:<poultice|tonic>:<creature id>` (the turn spent on a bag item), or `pass` (a turn let run out). */
  choice: string | null;
  misses: number;
  /** Bag items brought into the match, as the program's state has them. */
  items: Record<UsableItem, number>;
}
export type MatchEvent = { side: Side; kind: 'faint' | 'switch'; creature: string };
export type MatchPhase = 'locking' | 'battle' | 'done' | 'void';
/** How a match ended: the program's ends. */
export type MatchReason = End;
export interface Match {
  id: string;
  stake: number;
  phase: MatchPhase;
  turn: number;
  deadline: number;
  a: MatchSide;
  b: MatchSide;
  /** The last turn, in the order the creatures acted. */
  log: ({ side: Side } & ExchangeEntry)[];
  events: MatchEvent[];
  winner: Side | null;
  reason: MatchReason | null;
  /** What the program decides the match from (Base64 of canonical bytes). */
  program: MatchProgram;
  /** A staked match's stakes on DSM (src/modules/main/staked.ts). */
  escrow?: MatchEscrow;
}

/** An entry of a staked match's transcript, signed by its side's wallet under its session key. */
export interface SignedEntry { side: Side; entry: string; signature: string }
/** A move sealed (committed) and not yet revealed: the salt and the opening its commitment hides. */
export interface Sealed { salt: string; opening: string }
/**
 * A staked match's stakes, decided by the program (SoFi S22): each player's stake is locked in its
 * own vault on the match cell both setups bind; the wallets ready, sign each entry of the
 * transcript, and the winner's wallet settles the transcript at the match cell and collects. No
 * one signs a verdict. The game only relays and records what its account saw (Web2 record).
 */
export interface MatchEscrow {
  /** The nonce both session keys are derived for (Base32). */
  nonce: string;
  /** Each side's session public key (Base64), as its wallet named it. */
  keys: { a: string | null; b: string | null };
  /** Each side's vault (Base32), once the game's account saw it locked. */
  a: string | null;
  b: string | null;
  /** The match cell both vaults bind, K_match (Base32). */
  cell: string | null;
  /** A's ready signature (Base64), relayed to B, whose wallet then writes the Start. */
  ready: string | null;
  /** A's start entropy (Base64), handed out with its ready and relayed to B with it (SoFi S33). */
  reveal: string | null;
  /** What the start cell holds, as the game's account read it. */
  start: 'open' | 'started' | 'withdrawn';
  /** Every entry signed so far, in order: the transcript the winner settles. */
  transcript: SignedEntry[];
  /** This turn's sealed moves. */
  sealed: { a: Sealed | null; b: Sealed | null };
  /** This turn's revealed openings (Base64). */
  revealed: { a: string | null; b: string | null };
  /** The outcome at the match cell, once the account read it there. */
  outcome: 'a-wins' | 'b-wins' | 'void' | null;
  paid: boolean;
  refunded: { a: boolean; b: boolean };
  /** The last thing that went wrong, for the players; empty when nothing did. */
  problem: string;
}
export interface MatchProgram {
  /** The canonical setup both wallets lock: the program, the nonce, both sides and their teams. */
  setup: string;
  /** Both sides' start entropy (Base64), once the match's Start opened it; the state starts from it. */
  reveals: { a: string; b: string } | null;
  /** The program's state after the last turn. */
  state: string;
  /** Each turn's openings exactly as revealed. */
  turns: { a: string; b: string }[];
}
type MatchError = 'not-your-turn' | 'unknown-move' | 'no-charges' | 'match-over' | 'already-chosen' | 'no-item' | 'unknown-creature';

/** A team snapshot: each creature as prepared (HP and charges), with battle-only effects cleared. */
function snapshot(team: Creature[]): Creature[] {
  return team.map((c) => ({ ...structuredClone(c), guard: false, statuses: [] }));
}

export type Entrant = { wallet: string; name: string; team: Creature[]; items?: Partial<Record<UsableItem, number>> };
/**
 * A staked match while its setup is built and its stakes lock: the players and their teams as
 * prepared, and no setup yet (`loadSetup` gives it one).
 */
export function lockingMatch(id: string, stake: number, a: Entrant, b: Entrant): Match {
  const side = (p: Entrant): MatchSide => ({
    wallet: p.wallet, name: p.name, team: snapshot(p.team), active: 0, ko: 0, choice: null, misses: 0,
    // A setup carries at most 255 of each (one byte); a bag holds far fewer.
    items: { poultice: Math.min(255, p.items?.poultice ?? 0), tonic: Math.min(255, p.items?.tonic ?? 0) },
  });
  return {
    id, stake, phase: 'locking', turn: 0, deadline: 0, a: side(a), b: side(b), log: [], events: [], winner: null, reason: null,
    program: { setup: '', reveals: null, state: '', turns: [] },
  };
}

/** The match's canonical setup, held before its Start: no state yet, for the tiebreak is not derived yet. */
export function holdSetup(m: Match, setup: Uint8Array): void {
  m.program = { setup: b64(setup), reveals: null, state: '', turns: [] };
}

/**
 * The match's canonical setup, whose teams are its sides' creatures in order, started on both
 * sides' start entropy: the program's start state.
 */
export function loadSetup(m: Match, setup: Uint8Array, reveals: Reveals): void {
  const state = startState(setup, reveals);
  const view = stateView(state);
  m.program = { setup: b64(setup), reveals: { a: b64(reveals.a), b: b64(reveals.b) }, state: b64(state), turns: [] };
  project(m.a, view, 'a'); project(m.b, view, 'b');
}

/**
 * A match from its canonical setup, whose teams are `a`'s and `b`'s creatures in order (the setup
 * holds their states; the creatures give them their ids and names on screen).
 */
export function startMatch(id: string, stake: number, setup: Uint8Array, reveals: Reveals, a: Entrant, b: Entrant, now: number): Match {
  const m = lockingMatch(id, stake, a, b);
  loadSetup(m, setup, reveals);
  m.phase = 'battle';
  m.deadline = now + TURN_MS;
  return m;
}

/** `side`'s view of the program's state onto its screen team. */
function project(side: MatchSide, view: StateView, s: Side): MatchSide {
  const v = view[s];
  side.active = v.active; side.ko = v.ko;
  side.items = { poultice: v.poultice, tonic: v.tonic };
  v.team.forEach((f, i) => {
    const c = side.team[i];
    if (!c) return;
    c.xp = f.xp; c.hp = f.hp; c.guard = f.guard === 'up';
    c.statuses = f.statuses.map((x) => ({ id: x.id as Creature['statuses'][number]['id'], turns: x.turns }));
    c.charges = Object.fromEntries(SPECIES[c.species].moves.flatMap((m, k) => (m.max ? [[m.id, f.charges[k]]] : [])));
  });
  return side;
}

/** `item:<poultice|tonic>:<creature id>` names a bag item spent on one of the side's creatures. */
function parseItem(choice: string): { item: UsableItem; creatureId: string } | null {
  const [kind, item, ...rest] = choice.split(':');
  if (kind !== 'item' || (item !== 'poultice' && item !== 'tonic') || !rest.length) return null;
  return { item, creatureId: rest.join(':') };
}

/** The program's move for `side`'s choice, or why the game refuses it (the program itself would play it as a pass). */
export function moveOf(m: Match, side: Side, choice: string): MoveView | MatchError {
  const me = m[side];
  if (choice === 'pass') return { kind: 'pass' };
  if (choice === 'resign') return { kind: 'resign' };
  const item = parseItem(choice);
  if (item) {
    const teamIndex = me.team.findIndex((x) => x.id === item.creatureId);
    if (!(item.item in ITEMS) || me.items[item.item] === 0) return 'no-item';
    if (teamIndex < 0 || me.team[teamIndex].hp === 0) return 'unknown-creature';
    return { kind: 'item', item: ITEM_IDS.indexOf(item.item), teamIndex };
  }
  const c = me.team[me.active];
  const index = SPECIES[c.species].moves.findIndex((x) => x.id === choice);
  if (index < 0) return 'unknown-move';
  const def = SPECIES[c.species].moves[index];
  if (def.max && (c.charges[def.id] ?? 0) === 0) return 'no-charges';
  return { kind: 'move', index };
}

/** Records a player's choice for this turn. A free match resolves the turn once both are in. */
export function choose(m: Match, side: Side, choice: string, now: number): MatchError | null {
  if (m.phase !== 'battle') return 'match-over';
  const me = m[side];
  if (me.choice !== null) return 'already-chosen';
  if (choice === 'pass' || choice === 'resign') return 'unknown-move';
  const mv = moveOf(m, side, choice);
  if (typeof mv === 'string') return mv;
  me.choice = choice; me.misses = 0;
  if (m.stake === 0 && m[other(side)].choice !== null) resolveChoices(m, now);
  return null;
}

/** The canonical bytes of `side`'s choice this turn. */
export function openingOf(m: Match, side: Side): Uint8Array {
  const choice = m[side].choice;
  if (choice === null) throw new Error(`side ${side} has not chosen`);
  const mv = moveOf(m, side, choice);
  return encodeMove(typeof mv === 'string' ? { kind: 'pass' } : mv);
}

/** A free match's turn from both sides' choices. */
function resolveChoices(m: Match, now: number) {
  resolveTurn(m, openingOf(m, 'a'), openingOf(m, 'b'), now);
}

/**
 * At the deadline, a free match's player who has not chosen passes; three misses in a row resign
 * them. (A staked match has no such rule: its players' own wallets sign their passes.)
 */
export function expire(m: Match, now: number): void {
  if (m.phase !== 'battle' || m.stake > 0 || now < m.deadline) return;
  for (const s of ['a', 'b'] as const) {
    if (m[s].choice !== null) continue;
    m[s].misses += 1;
    if (m[s].misses >= MISSES_TO_FORFEIT) { resign(m, s, now); return; }
    m[s].choice = 'pass';
  }
  resolveChoices(m, now);
}

/** `side` resigns: the program plays its turn as a resignation, with the other side's choice if it made one. */
export function resign(m: Match, side: Side, now: number, otherOpening?: Uint8Array): void {
  if (m.phase !== 'battle') return;
  const theirs = otherOpening ?? (m[other(side)].choice !== null ? openingOf(m, other(side)) : encodeMove({ kind: 'pass' }));
  const mine = encodeMove({ kind: 'resign' });
  resolveTurn(m, side === 'a' ? mine : theirs, side === 'a' ? theirs : mine, now);
}

/** A free match's forfeit: the player resigns. */
export const forfeit = (m: Match, side: Side, now = Date.now()): void => resign(m, side, now);

const moveName = (m: Match, side: Side, active: number, played: MoveView): string => {
  if (played.kind === 'move') return SPECIES[m[side].team[active].species].moves[played.index]?.id ?? 'pass';
  if (played.kind === 'item') return `item:${ITEM_IDS[played.item]}`;
  return played.kind;
};

/**
 * One turn from both sides' openings exactly as revealed, by the program: its state, the
 * screens' views of it, the log and the end when the turn decided the match.
 */
export function resolveTurn(m: Match, a: Uint8Array, b: Uint8Array, now: number): LogView {
  const acting = { a: m.a.active, b: m.b.active };
  const { state, log } = playTurn(unb64(m.program.state), a, b);
  m.program.state = b64(state);
  m.program.turns.push({ a: b64(a), b: b64(b) });
  const view = stateView(state);
  project(m.a, view, 'a'); project(m.b, view, 'b');
  m.log = log.actions.map((x) => ({
    side: x.side, move: moveName(m, x.side, acting[x.side], x.played), dmg: x.dmg, mult: x.multX4 / 4,
    ...(x.status ? { status: x.status } : {}), burn: x.burn, skipped: x.acted === 'held',
  }));
  m.events = log.events.map((e) => ({ side: e.side, kind: e.kind, creature: m[e.side].team[e.teamIndex].id }));
  m.turn = view.turn;
  m.a.choice = null; m.b.choice = null;
  if (log.end) { m.phase = 'done'; m.winner = log.end.winner; m.reason = log.end.end; }
  else m.deadline = now + TURN_MS;
  return log;
}
