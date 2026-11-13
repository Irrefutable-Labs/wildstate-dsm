/**
 * The staked-match program (Rust, compiled to WASM: DSM `crates/wildstate-duel-wasm`, vendored in
 * src/vendor/wildstate-duel, which every match now runs on) against this game's own engine as it was
 * before (`test/support/reference-match.ts` → `src/domain/duel.ts`, the rules wild and trainer
 * battles still play):
 *  (a) the program reproduces its frozen vectors, and each vector whose moves are all ones this
 *      engine accepts plays out the same here, turn by turn;
 *  (b) 10,000 seeded random matches of legal moves play out identically, turn by turn: every HP,
 *      charge, status, guard, item, active creature, knockout count, log entry and event;
 *  (c) this game's tables encode to the program's tables digest.
 * The program's deliberate changes are aligned, not compared: a level tie's first actor is the
 * program's (the match id is chosen so the TS tie-break agrees), the missed-turn forfeit is off
 * (no clocks), and the turn cap decides only in the program.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as vendored from '../src/vendor/wildstate-duel/wildstate_duel_wasm.js';
import { WASM_BASE64 } from '../src/vendor/wildstate-duel/wasm-bytes.js';
import {
  BASE_HP, ELEMENTS, HP_PER_LEVEL, ITEMS, LEVEL_CAP, SPECIES, STATUSES, TEAM_SIZE, XP_PER_LEVEL,
  chargeBonus, level, maxCharges, maxHp, multiplier, newCreature, type Creature, type Element, type UsableItem,
} from '../src/domain/game';
import { choose, expire, firstToAct, forfeit, startMatch, type Match, type Side } from './support/reference-match';

type Duel = {
  conformanceVectors(): { label: string; setup: Uint8Array; revealA: Uint8Array; revealB: Uint8Array; turns: Uint8Array[]; opened: { a: Uint8Array; b: Uint8Array }[]; winner: Side; end: string; finalState: Uint8Array }[];
  turnOfOpenings(a: Uint8Array, b: Uint8Array): Uint8Array;
  encodeMove(mv: unknown): Uint8Array;
  encodeSetup(setup: unknown): Uint8Array;
  encodeTurn(a: Uint8Array, b: Uint8Array): Uint8Array;
  outcome(setup: Uint8Array, revealA: Uint8Array, revealB: Uint8Array, turns: Uint8Array[]): { winner: Side; end: string; turns: number };
  programHash(): Uint8Array;
  startCommitment(entropy: Uint8Array): Uint8Array;
  startState(setup: Uint8Array, revealA: Uint8Array, revealB: Uint8Array): Uint8Array;
  stateDigest(state: Uint8Array): Uint8Array;
  stateView(state: Uint8Array): StateView;
  step(state: Uint8Array, turn: Uint8Array): { state: Uint8Array; log: LogView };
  tablesDigest(): Uint8Array;
  tablesDigestOf(ccb: Uint8Array): Uint8Array;
  tablesEncoding(): Uint8Array;
  turnView(turn: Uint8Array): { a: MoveView; b: MoveView };
  verifyConformance(): number;
};
type MoveView = { kind: 'move'; index: number } | { kind: 'item'; item: number; teamIndex: number } | { kind: 'pass' } | { kind: 'resign' };
type FighterView = { species: string; xp: number; hp: number; charges: number[]; guard: 'up' | 'down'; statuses: { id: string; turns: number }[] };
type SideView = { poultice: number; tonic: number; active: number; ko: number; team: FighterView[] };
type WinnerView = { winner: Side; end: string; turns: number };
type StateView = { turn: number; winner: WinnerView | null; a: SideView; b: SideView };
type LogView = {
  turn: number; first: Side | null;
  actions: { side: Side; played: MoveView; dmg: number; multX4: number; status: string | null; burn: number; acted: 'acted' | 'held' }[];
  events: { side: Side; kind: 'faint' | 'switch'; teamIndex: number }[];
  end: WinnerView | null;
};
const duel = vendored as unknown as Duel;

const SPECIES_IDS = Object.keys(SPECIES);
const ITEM_IDS = Object.keys(ITEMS) as UsableItem[];
const ELEMENT_IDS = Object.keys(ELEMENTS) as Element[];
const STATUS_IDS = Object.keys(STATUSES);
const TURN_CAP = 60;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** mulberry32: a fixed, seeded sequence. */
function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

/** The ordered pair of one turn: TS side keyed by the program's side. */
type Opened = { a: MoveView; b: MoveView };

/**
 * Plays one turn in the TS engine. Returns null when the TS engine refuses a move (the program
 * plays it as a pass: a deliberate change, so the match is no longer comparable).
 */
function playTs(m: Match, opened: Opened, expectedFirst: Side | null): 'ok' | 'refused' {
  if (opened.a.kind === 'resign' && opened.b.kind === 'resign') return 'refused';
  for (const s of ['a', 'b'] as const) if (opened[s].kind === 'resign') { forfeit(m, s); return 'ok'; }
  // Align a level tie's first actor with the program's (the program reads its seed, not the id).
  if (expectedFirst) {
    for (let k = 0; firstToAct(m) !== expectedFirst; k++) {
      m.id = `equivalence/${k}`;
      if (k > 64) throw new Error('no match id gives the program\'s first actor');
    }
  }
  const passes: Side[] = [];
  for (const s of ['a', 'b'] as const) {
    const mv = opened[s];
    if (mv.kind === 'pass') { passes.push(s); continue; }
    const side = m[s];
    const choice = mv.kind === 'move'
      ? (SPECIES[side.team[side.active].species].moves[mv.index]?.id ?? `unknown-${mv.index}`)
      : mv.kind === 'item' ? `item:${ITEM_IDS[mv.item] ?? 'unknown'}:${side.team[mv.teamIndex]?.id ?? 'unknown'}` : 'resign';
    if (choose(m, s, choice, 0) !== null) return 'refused';
  }
  if (passes.length) {
    // No clocks in the program: the missed-turn forfeit is not one of its rules.
    m.a.misses = 0; m.b.misses = 0;
    expire(m, m.deadline);
  }
  return 'ok';
}

const chargesArray = (c: Creature) => SPECIES[c.species].moves.map(mv => (mv.max ? c.charges[mv.id] : 0));

/** Every field the program's state view shows, from the TS match. */
function tsView(m: Match): Omit<StateView, 'turn' | 'winner'> {
  const side = (s: Side): SideView => ({
    poultice: m[s].items.poultice, tonic: m[s].items.tonic, active: m[s].active, ko: m[s].ko,
    team: m[s].team.map(c => ({ species: c.species, xp: c.xp, hp: c.hp, charges: chargesArray(c), guard: c.guard ? 'up' : 'down', statuses: c.statuses.map(x => ({ id: x.id, turns: x.turns })) })),
  });
  return { a: side('a'), b: side('b') };
}

/** The TS log, written the way the program's log view writes it. */
function tsLog(m: Match) {
  return m.log.map(e => ({ side: e.side, move: e.move, dmg: e.dmg, mult: e.mult, status: e.status ?? null, burn: e.burn, skipped: e.skipped }));
}
function wasmLog(log: LogView, before: Match) {
  return log.actions.map(x => {
    const side = before[x.side];
    const move = x.played.kind === 'move' ? SPECIES[side.team[side.active].species].moves[x.played.index].id
      : x.played.kind === 'item' ? `item:${ITEM_IDS[x.played.item]}` : x.played.kind;
    return { side: x.side, move, dmg: x.dmg, mult: x.multX4 / 4, status: x.status, burn: x.burn, skipped: x.acted === 'held' };
  });
}
function wasmEvents(m: Match, log: LogView) {
  return log.events.map(e => ({ side: e.side, kind: e.kind, creature: m[e.side].team[e.teamIndex].id }));
}

/** A TS match from the program's view of the state before turn 0. */
function tsMatchFrom(view: StateView): Match {
  const entrant = (s: Side) => ({
    wallet: s, name: s,
    team: view[s].team.map((f, i) => {
      const c = newCreature(`${s}/${i}`, f.species as keyof typeof SPECIES, f.hp);
      c.xp = f.xp; c.hp = f.hp;
      c.charges = Object.fromEntries(SPECIES[f.species].moves.flatMap((mv, k) => (mv.max ? [[mv.id, f.charges[k]]] : [])));
      return c;
    }),
    items: { poultice: view[s].poultice, tonic: view[s].tonic },
  });
  return startMatch('equivalence/start', 0, entrant('a'), entrant('b'), 0);
}

type Compared = { turns: number; comparable: boolean; decided: Side | null };

/** Steps the program and the TS engine together and compares every turn. */
function lockstep(setup: Uint8Array, revealA: Uint8Array, revealB: Uint8Array, turns: Uint8Array[]): Compared {
  let state = duel.startState(setup, revealA, revealB);
  const m = tsMatchFrom(duel.stateView(state));
  for (let i = 0; i < turns.length; i++) {
    const opened = duel.turnView(turns[i]);
    const before = structuredClone(m);
    const { state: next, log } = duel.step(state, turns[i]);
    state = next;
    if (playTs(m, opened, log.first) === 'refused') return { turns: i, comparable: false, decided: null };
    const view = duel.stateView(state);
    expect(tsView(m), `turn ${i} state`).toEqual({ a: view.a, b: view.b });
    if (log.first) {
      expect(tsLog(m), `turn ${i} log`).toEqual(wasmLog(log, before));
      expect(m.events, `turn ${i} events`).toEqual(wasmEvents(m, log));
      expect(m.turn, `turn ${i} counter`).toBe(view.turn);
    }
    if (log.end && (log.end.end === 'knockouts' || log.end.end === 'resign')) {
      expect(m.phase).toBe('done');
      expect(m.winner).toBe(log.end.winner);
      return { turns: i + 1, comparable: true, decided: log.end.winner };
    }
    if (log.end) return { turns: i + 1, comparable: true, decided: null };
    expect(m.phase, `turn ${i} phase`).toBe('battle');
  }
  return { turns: turns.length, comparable: true, decided: null };
}

describe('the staked-match program matches the game engine', () => {
  it('(a) reproduces its frozen vectors, and the comparable ones play the same here', () => {
    const vectors = duel.conformanceVectors();
    expect(duel.verifyConformance()).toBe(vectors.length);
    let comparable = 0, decidedHere = 0;
    for (const v of vectors) {
      const out = duel.outcome(v.setup, v.revealA, v.revealB, v.turns);
      expect({ winner: out.winner, end: out.end, turns: out.turns }, v.label).toEqual({ winner: v.winner, end: v.end, turns: v.turns.length });
      let state = duel.startState(v.setup, v.revealA, v.revealB);
      for (const t of v.turns) state = duel.step(state, t).state;
      expect(hex(duel.stateDigest(state)), v.label).toBe(hex(v.finalState));
      const r = lockstep(v.setup, v.revealA, v.revealB, v.turns);
      if (r.comparable) comparable += 1;
      if (r.decided) { decidedHere += 1; expect(r.decided, v.label).toBe(v.winner); }
    }
    console.log(`[equivalence] vectors: ${vectors.length}, comparable in TS: ${comparable}, decided identically in TS: ${decidedHere}`);
    expect(comparable).toBeGreaterThan(vectors.length / 2);
  });

  it('(b) plays 10,000 seeded random matches identically, turn by turn', () => {
    const r = rng(0x5eed2026);
    const program = duel.programHash();
    const bytes32 = (tag: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? tag : r(256)));
    let decided = 0, capped = 0, turnsPlayed = 0, ties = 0;
    for (let n = 0; n < 10_000; n++) {
      let anchor = 0;
      const team = () => Array.from({ length: 1 + r(TEAM_SIZE) }, () => {
        const species = r(SPECIES_IDS.length), lvl = 1 + r(LEVEL_CAP);
        const xp = (lvl - 1) * XP_PER_LEVEL + r(XP_PER_LEVEL);
        const max = maxHp({ xp });
        const charges = SPECIES[SPECIES_IDS[species]].moves.map(mv => (mv.max ? r(maxCharges(mv, { xp }) + 1) : 0));
        return { anchor: bytes32(++anchor), species, xp, hp: r(2) ? max : 1 + r(max), charges };
      });
      const side = (key: number) => ({ genesis: bytes32(key), deviceId: bytes32(key + 1), sessionPublicKey: bytes32(key + 2), poultice: r(3), tonic: r(3), team: team() });
      const revealA = bytes32(r(256)), revealB = bytes32(r(256));
      const setup = duel.encodeSetup({
        program, matchNonce: bytes32(n & 255), turnCap: TURN_CAP,
        startCommitmentA: duel.startCommitment(revealA), startCommitmentB: duel.startCommitment(revealB), a: side(1), b: side(4),
      });

      let state = duel.startState(setup, revealA, revealB);
      const m = tsMatchFrom(duel.stateView(state));
      for (let t = 0; ; t++) {
        // Legal moves only: a move with a charge, an item in stock on a standing creature, a pass, rarely a resignation.
        const pick = (s: Side): MoveView => {
          const me = m[s], c = me.team[me.active];
          const roll = r(1000);
          if (roll < 2) return { kind: 'resign' };
          if (roll < 60) return { kind: 'pass' };
          const stocked = ITEM_IDS.map((id, i) => [id, i] as const).filter(([id]) => me.items[id] > 0);
          const standing = me.team.map((x, i) => [x, i] as const).filter(([x]) => x.hp > 0);
          if (roll < 160 && stocked.length) return { kind: 'item', item: stocked[r(stocked.length)][1], teamIndex: standing[r(standing.length)][1] };
          const usable = SPECIES[c.species].moves.map((mv, i) => [mv, i] as const).filter(([mv]) => !mv.max || (c.charges[mv.id] ?? 0) > 0);
          return { kind: 'move', index: usable[r(usable.length)][1] };
        };
        const opened = { a: pick('a'), b: pick('b') };
        if (opened.a.kind === 'resign' && opened.b.kind === 'resign') opened.b = { kind: 'pass' };
        const turn = duel.encodeTurn(duel.encodeMove(opened.a), duel.encodeMove(opened.b));
        const before = structuredClone(m);
        const { state: next, log } = duel.step(state, turn);
        state = next;
        if (log.first && level(before.a.team[before.a.active]) === level(before.b.team[before.b.active])) ties += 1;
        expect(playTs(m, opened, log.first), `match ${n} turn ${t}`).toBe('ok');
        const view = duel.stateView(state);
        expect(tsView(m), `match ${n} turn ${t} state`).toEqual({ a: view.a, b: view.b });
        if (log.first) {
          expect(tsLog(m), `match ${n} turn ${t} log`).toEqual(wasmLog(log, before));
          expect(m.events, `match ${n} turn ${t} events`).toEqual(wasmEvents(m, log));
        }
        turnsPlayed += 1;
        if (log.end) {
          if (log.end.end === 'knockouts' || log.end.end === 'resign') {
            expect(m.phase).toBe('done');
            expect(m.winner, `match ${n} winner`).toBe(log.end.winner);
            decided += 1;
          } else {
            expect(log.end.turns).toBe(TURN_CAP);
            expect(m.phase).toBe('battle');
            capped += 1;
          }
          break;
        }
        expect(m.phase, `match ${n} turn ${t}`).toBe('battle');
      }
    }
    console.log(`[equivalence] random: 10000 matches, ${turnsPlayed} turns, ${decided} decided in both, ${capped} at the cap (program only), ${ties} level-tie turns aligned`);
    expect(decided + capped).toBe(10_000);
  }, 600_000);

  it('(c) the game tables encode to the program\'s tables digest', () => {
    const out: number[] = [];
    const u8 = (n: number) => out.push(n & 255);
    const u16 = (n: number) => { u8(n >> 8); u8(n); };
    const u32 = (n: number) => { u16(n >>> 16); u16(n & 0xffff); };
    const bytes = (b: number[]) => { u32(b.length); b.forEach(u8); };
    const str = (s: string) => bytes([...Buffer.from(s, 'utf8')]);
    const count = (n: number) => u32(n);
    u16(0x5707); u16(1);
    count(ELEMENT_IDS.length);
    for (const id of ELEMENT_IDS) { str(id); bytes(ELEMENTS[id].beats.map(e => ELEMENT_IDS.indexOf(e))); }
    count(STATUS_IDS.length);
    for (const id of STATUS_IDS) { str(id); u8(STATUSES[id as keyof typeof STATUSES].turns); }
    count(SPECIES_IDS.length);
    for (const id of SPECIES_IDS) {
      const sp = SPECIES[id];
      str(id); u8(ELEMENT_IDS.indexOf(sp.el)); count(sp.moves.length);
      for (const mv of sp.moves) {
        str(mv.id); u8(ELEMENT_IDS.indexOf(mv.el)); u8(mv.max);
        if (mv.guard) u8(1);
        else if (mv.heal) { u8(2); u8(mv.heal); }
        else { u8(0); u8(mv.dmg!); bytes(mv.status ? [STATUS_IDS.indexOf(mv.status)] : []); }
      }
    }
    count(ITEM_IDS.length);
    str('poultice'); u8(0); u16(ITEMS.poultice.heal);
    str('tonic'); u8(1);
    u32(XP_PER_LEVEL); u8(LEVEL_CAP); u16(BASE_HP); u16(HP_PER_LEVEL);
    // The levels where chargeBonus steps up.
    const steps: number[] = [];
    for (let l = 2; l <= LEVEL_CAP; l++) if (chargeBonus({ xp: (l - 1) * XP_PER_LEVEL }) > chargeBonus({ xp: (l - 2) * XP_PER_LEVEL })) steps.push(l);
    bytes(steps);
    u16(multiplier('fire', 'grass') * 4); u16(multiplier('none', 'none') * 4); u16(multiplier('grass', 'fire') * 4);
    // duel.ts damage(): soaked `Math.max(1, d - 2)`, ×4; tick(): a burn deals 3; TEAM_SIZE per side.
    u16(2 * 4); u16(1 * 4); u16(3); u16(TURN_CAP); u8(TEAM_SIZE);
    const ts = Uint8Array.from(out);
    expect(hex(ts)).toBe(hex(duel.tablesEncoding()));
    expect(hex(duel.tablesDigestOf(ts))).toBe(hex(duel.tablesDigest()));
  });

  it('(d) runs the vendored program the escrow pins, and plays a garbled opening as a pass', () => {
    // The embedded bytes are the vendored .wasm, and it is the program P the DSM SDK pins.
    expect(Buffer.from(WASM_BASE64, 'base64').equals(readFileSync(new URL('../src/vendor/wildstate-duel/wildstate_duel_wasm_bg.wasm', import.meta.url)))).toBe(true);
    expect(hex(duel.programHash())).toBe('a7a9543303678e6944654c16a3b20aad13039a850ddf63662a9cbe35d75f7fb2');
    // Every frozen vector's openings, garbled ones included, are the turns it was decided by.
    let garbled = 0;
    for (const v of duel.conformanceVectors()) {
      v.opened.forEach((o, i) => {
        expect(hex(duel.turnOfOpenings(o.a, o.b)), `${v.label} turn ${i}`).toBe(hex(v.turns[i]));
        const canonical = (x: Uint8Array) => hex(duel.encodeMove(duel.turnView(duel.turnOfOpenings(x, x)).a)) === hex(x);
        if (!canonical(o.a) || !canonical(o.b)) garbled += 1;
      });
    }
    expect(garbled).toBeGreaterThan(0);
  });
});
