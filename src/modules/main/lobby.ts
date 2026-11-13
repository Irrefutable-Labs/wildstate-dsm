/**
 * The lobby: challenge a friend by username or DSM identity, or wait for the matchmaker to pair
 * you by stake and rating; then a player-vs-player match on the battle screen.
 *
 * Identity is the wallet's DSM account id; usernames, ratings and history are the game's own
 * records keyed by it (src/domain/username.ts). Every turn of every match is resolved by the
 * staked-match program (src/domain/program.ts). A free match is the game's alone. A staked match
 * is decided by that program on DSM (src/modules/main/staked.ts): each player's wallet locks its
 * own stake, signs its own moves, and the winner's wallet settles and collects. No referee.
 */
import { Components, type RpgPlayer } from '@rpgjs/server';
import { session } from './journey';
import { deliverUnissued, lobbyRecord, playerOfWallet, refreshContacts, walletContacts, walletIdentity, walletOf, walletWaiting, web2 } from './dsm';
import { commit, isFighting, setFighting, setInArena, setInMatch } from './field';
import { isSpeaking } from './dialogue';
import { SPECIES, GameError, displayName, fieldedTeam, level, maxCharges, maxHp, type Command, type Creature, type GameState } from '../../domain/game';
import { befriend, claimUsername, freshProfile, resolvePlayer, shownName, unfriend, HISTORY_MAX, RENAME_COOLDOWN_MS, type Directory, type MatchSummary } from '../../domain/username';
import { pair, window, validStake, STAKE_TIERS, MAX_STAKE, type Ticket } from '../../domain/matchmaker';
import { choose, expire, forfeit, loadSetup, lockingMatch, other, TURN_MS, type Match, type Side } from '../../domain/match';
import { creatureState, encodeSetup, startCommitment, type Reveals } from '../../domain/program';
import { fromB32 } from '../../integrations/dsm/host';
import {
  advance, chooseStaked, findLateLock, freshEscrow, lockMatch, matchNonce, passIfDue, payOut, resignStaked, withdrawAndRefund,
  type StakedEvents,
} from './staked';
import { createHash, randomBytes } from 'node:crypto';
import { rate } from '../../domain/rating';

/** Stakes are locked on DSM and the program decides the match (S22): each wallet locks its own, and the winner's collects both. */
const WAGERS_OPEN = true;
const stakeOpen = (stake: number) => validStake(stake) && (stake === 0 || WAGERS_OPEN);
const CHALLENGE_MS = 120_000;
/** A player who drops out of a free match has this long to come back before resigning. A staked match waits for them. */
const GRACE_MS = 60_000;

interface Challenge { id: string; from: string; to: string; stake: number; at: number }
const queue = new Map<string, Ticket>();
const challenges = new Map<string, Challenge>();
/** Each wallet's live match, and when its player dropped out of it. */
const liveOf = new Map<string, string>();
const absentSince = new Map<string, number>();
/** The move each side chose for the turn that just resolved, so its screen animates it as its own. */
const chosen = new Map<string, string>();
const notices = new Map<string, string>();
/** Who each player last found in FRIENDS: kept between the lobby's refreshes until they challenge or search again. */
const founds = new Map<string, string>();
let serial = 0;

const sideOf = (m: Match, wallet: string): Side => (m.a.wallet === wallet ? 'a' : 'b');

/** A team for a match: the chosen team (else the lead and the rest), standing creatures only, as prepared. */
function pvpTeam(s: GameState): Creature[] {
  return fieldedTeam(s).map(id => s.creatures.find(c => c.id === id)!);
}
/** The player's creatures for the lobby's team step: who is picked, how they stand, and what items can help. */
function teamView(s: GameState) {
  return {
    picked: fieldedTeam(s),
    chosen: s.team,
    poultice: s.inventory.poultice, tonic: s.inventory.tonic,
    creatures: s.creatures.map(c => ({
      id: c.id, name: displayName(c), species: c.species, level: level(c), hp: c.hp, maxHp: maxHp(c),
      charges: SPECIES[c.species].moves.filter(m => m.max).map(m => ({ name: m.name, left: c.charges[m.id] ?? 0, max: maxCharges(m, c) })),
    })),
  };
}

// ------------------------------------------------------------------ views

async function lobbyView(player: RpgPlayer) {
  const wallet = walletOf(player)!;
  const { dir, matches } = await lobbyRecord();
  const me = dir.players[wallet] ?? freshProfile();
  const brief = (id: string) => ({ id, name: shownName(dir, id), rating: dir.players[id]?.rating ?? 1200, online: playerOfWallet(id) !== null });
  const ticket = queue.get(wallet);
  const now = Date.now();
  return {
    now,
    me: { id: wallet, name: me.username, rating: me.rating, wins: me.wins, losses: me.losses, games: me.games, renameReadyAt: me.username ? me.renamedAt + RENAME_COOLDOWN_MS : 0 },
    stakes: STAKE_TIERS, maxStake: MAX_STAKE, wagersOpen: WAGERS_OPEN,
    queued: ticket ? { stake: ticket.stake, since: ticket.since, window: window(now - ticket.since) } : null,
    incoming: [...challenges.values()].filter(c => c.to === wallet).map(c => ({ id: c.id, from: brief(c.from), stake: c.stake, expiresAt: c.at + CHALLENGE_MS })),
    outgoing: [...challenges.values()].filter(c => c.from === wallet).map(c => ({ id: c.id, to: brief(c.to), stake: c.stake, expiresAt: c.at + CHALLENGE_MS })),
    history: me.history.map(h => ({ ...h, opponentName: shownName(dir, h.opponent) })),
    live: liveOf.get(wallet) ?? null,
    liveMatch: (() => {
      const id = liveOf.get(wallet); const m = id ? matches[id] : undefined;
      if (!m) return null;
      const mine = sideOf(m, wallet), e = m.escrow;
      // While the stakes lock and the wallets ready: each step, so each player sees whom the match waits on.
      const locking = m.phase === 'locking' && e ? {
        keys: !!e.keys.a && !!e.keys.b, mine: !!e[mine], theirs: !!e[other(mine)],
        ready: { mine: mine === 'a' ? !!e.ready : e.start === 'started', theirs: mine === 'a' ? e.start === 'started' : !!e.ready },
        started: e.start === 'started',
      } : null;
      return { id: m.id, stake: m.stake, opponent: brief(m[other(mine)].wallet), locking };
    })(),
    notice: notices.get(wallet) ?? '',
    walletWaiting: walletWaiting(player),
    found: (() => { const f = founds.get(wallet); return f ? brief(f) : null; })(),
    // Everyone this player found, challenged or played, and every contact their wallet shared (DSM
    // Amendment A16), whether or not they ever opened the game: online first, as the lobby sees them now.
    friends: (() => {
      const contacts = walletContacts(wallet).filter((id) => id !== wallet);
      return [...new Set([...(me.friends ?? []), ...contacts])]
        .map((id) => ({ ...brief(id), playing: liveOf.has(id), contact: contacts.includes(id) }))
        .sort((x, y) => Number(y.online) - Number(x.online));
    })(),
    team: teamView(session(player).read()),
  };
}

/** The match as one side's battle screen sees it: its own team, the other side's active creature. */
function battleView(m: Match, side: Side) {
  const me = m[side], foe = m[other(side)], e = m.escrow;
  const outcome = m.phase === 'battle' ? 'active' : m.winner === side ? 'victory' : 'defeat';
  const state = {
    rules: 'creatures-v4', holder: me.wallet, revision: m.turn, nextEncounter: 0, nextCast: 0,
    creatures: me.team, lead: 0, team: me.team.map(c => c.id),
    inventory: { capsules: 0, rod: false, poultice: me.items.poultice, tonic: me.items.tonic, map: 0 }, coins: 0,
    campaign: { instance: '', branch: 'unselected' }, consumed: [], commandIds: [], victories: 0, captures: 0, trainersBeaten: [], scarecrowReadyAt: 0,
    battle: {
      id: m.id, creatureId: me.team[me.active].id, wild: foe.team[foe.active], turn: m.turn, source: 'trainer', outcome,
      log: m.log.map(({ side: s, ...e }) => ({ actor: s === side ? 'own' : 'wild', ...e })),
      format: 'team3', roster: me.team.map(c => c.id), bench: foe.team.filter((c, i) => i !== foe.active && c.hp > 0),
      ko: { own: me.ko, foe: foe.ko }, events: m.events.map(e => ({ side: e.side === side ? 'own' : 'foe', kind: e.kind, creature: e.creature })),
    },
  };
  return {
    state, mode: 'pvp', lastAction: chosen.get(`${m.id}/${side}`) ?? '', error: '',
    // Whose move it is: whether each side has chosen this turn (never what the opponent chose).
    pvp: {
      opponent: foe.name, stake: m.stake, deadline: m.deadline, waiting: me.choice !== null && foe.choice === null, chosen: me.choice !== null,
      foeReady: e ? !!e.sealed[other(side)] : foe.choice !== null, reason: m.reason,
      // A staked match: each move sealed by its player's wallet, then revealed; settled by the program.
      staked: e ? {
        sealed: { mine: !!e.sealed[side], theirs: !!e.sealed[other(side)] },
        revealed: { mine: !!e.revealed[side], theirs: !!e.revealed[other(side)] },
        entries: e.transcript.length,
        outcome: e.outcome, paid: e.paid, problem: e.problem,
      } : null,
    },
  };
}

// ------------------------------------------------------------------ lobby GUI

let started = false;
/** Starts the lobby's clock once, after voiding matches a server restart cut off. */
async function ensureStarted() {
  if (started) return;
  started = true;
  await voidStaleMatches();
  setInterval(() => { void tickLobby(); }, 1000);
}

export async function openLobby(player: RpgPlayer): Promise<void> {
  await ensureStarted();
  const wallet = walletOf(player);
  if (!wallet || isFighting(player) || isSpeaking(player)) return;
  const gui = player.gui('lobby');
  gui.on<{ action: string; name?: string; query?: string; to?: string; stake?: number; id?: string; creatureIds?: unknown[]; item?: string; creatureId?: string }>('lobby', async (d) => {
    const say = (text: string) => notices.set(wallet, text);
    notices.delete(wallet);
    const { dir, save } = await lobbyRecord();
    switch (d.action) {
      case 'close': setInArena(player, false); gui.close(); return;
      case 'set-name': {
        const error = claimUsername(dir, wallet, String(d.name ?? ''), Date.now());
        if (error) say(NAME_ERRORS[error]); else { save(); nameTag(player, dir.players[wallet].username!, wallet); web2(player, 'Username', `Now known as @${dir.players[wallet].username}; your rating and history stay with your DSM identity`); }
        break;
      }
      case 'find': {
        const found = resolvePlayer(dir, String(d.query ?? ''));
        founds.delete(wallet);
        // The result is its own card, with the challenge on it; only a miss needs words.
        if (!found) say('No player by that name or ID.');
        else if (found === wallet) say('That is you.');
        else { founds.set(wallet, found); befriend(dir, wallet, found); save(); }
        break;
      }
      case 'challenge': {
        const to = String(d.to ?? ''), stake = Number(d.stake ?? 0);
        if (!validStake(stake)) say('Name a whole amount of WILD.');
        else if (!stakeOpen(stake)) say('Staked matches open once the DSM wallet can lock a stake.');
        else if (to === wallet || !playerOfWallet(to)) say('That player is not online.');
        else if (pvpTeam(session(player).read()).length === 0) say('Heal a creature first: your team has none standing.');
        else if (liveOf.has(to) || liveOf.has(wallet)) say('One of you is already in a match.');
        else { const id = `ch/${Date.now().toString(36)}/${serial++}`; challenges.set(id, { id, from: wallet, to, stake, at: Date.now() }); founds.delete(wallet); befriend(dir, wallet, to); befriend(dir, to, wallet); save(); say(`Challenge sent to @${shownName(dir, to)}.`); void refreshLobby(to); }
        break;
      }
      case 'accept': {
        const c = challenges.get(String(d.id ?? ''));
        if (!c || c.to !== wallet) { say('That challenge is gone.'); break; }
        if (pvpTeam(session(player).read()).length === 0) { say('Heal a creature first: your team has none standing.'); break; }
        challenges.delete(c.id);
        await begin(c.from, c.to, c.stake);
        return;
      }
      case 'decline':
      case 'cancel': {
        const c = challenges.get(String(d.id ?? ''));
        if (c && (c.to === wallet || c.from === wallet)) { challenges.delete(c.id); void refreshLobby(c.to === wallet ? c.from : c.to); }
        break;
      }
      case 'queue': {
        const stake = Number(d.stake ?? 0);
        if (!(STAKE_TIERS as readonly number[]).includes(stake)) { say('Pick one of the matchmaker stakes.'); break; }
        if (!stakeOpen(stake)) { say('Staked matches open once the DSM wallet can lock a stake.'); break; }
        if (pvpTeam(session(player).read()).length === 0) { say('Heal a creature first: your team has none standing.'); break; }
        queue.set(wallet, { wallet, rating: (dir.players[wallet] ?? freshProfile()).rating, stake, since: Date.now() });
        break;
      }
      case 'leave-queue': queue.delete(wallet); break;
      case 'unfriend': unfriend(dir, wallet, String(d.id ?? '')); save(); break;
      // The team step: pick up to three, and heal or recharge them with bag items.
      case 'set-team':
      case 'use-item': {
        const command: Command = d.action === 'set-team'
          ? { type: 'set-team', creatureIds: Array.isArray(d.creatureIds) ? d.creatureIds.filter((x): x is string => typeof x === 'string') : [] }
          : { type: 'use-item', item: d.item === 'tonic' ? 'tonic' : 'poultice', creatureId: String(d.creatureId ?? '') };
        try { commit(player, command, session(player).read().revision); }
        catch (e) { if (!(e instanceof GameError)) throw e; say(player.t(`game.error.${e.code}`)); }
        break;
      }
      default: return;
    }
    gui.update(await lobbyView(player));
  });
  setInArena(player, true);
  // The lobby holds the player where they stand: a tap on it is never a step on the map beneath.
  void gui.open(await lobbyView(player), { blockPlayerInput: true });
  // The wallet's contacts as they are now, into FRIENDS once they arrive.
  refreshContacts(player)
    .then(async () => { if (player.getGui('lobby')) gui.update(await lobbyView(player)); })
    .catch((e) => web2(player, 'Friends from your wallet', `not read: ${e instanceof Error ? e.message : String(e)}`, 'fail'));
}

const NAME_ERRORS = {
  'invalid-username': 'Use 3 to 16 letters, digits or underscores.',
  'reserved-username': 'That name belongs to the game.',
  'username-taken': 'That name is taken.',
  'rename-cooldown': 'You can change your name once a day.',
} as const;

async function refreshLobby(wallet: string) {
  const p = playerOfWallet(wallet);
  const gui = p?.getGui('lobby');
  if (p && gui) gui.update(await lobbyView(p));
}

/** Called when a player leaves the server: it leaves the queue, and its challenges lapse. */
export function leaveLobby(player: RpgPlayer) {
  setInArena(player, false);
  const wallet = walletOf(player);
  if (!wallet) return;
  queue.delete(wallet);
  for (const c of challenges.values()) if (c.from === wallet || c.to === wallet) challenges.delete(c.id);
  if (liveOf.has(wallet)) absentSince.set(wallet, Date.now());
}

/** Called when a player's wallet is connected: rejoin a live match, and take the name it chose. */
/**
 * Every character on the map wears its player's name, so another phone's character standing about
 * reads as someone else, not as a frozen copy of your own: the username, or the start of the DSM id.
 */
function nameTag(player: RpgPlayer, username: string | null, wallet: string) {
  player.name = username ? `@${username}` : wallet.slice(0, 6);
  // Black on a thick white outline reads on grass, path and water alike. The client hands the
  // outline to Pixi as is, so it takes a width as well as a colour.
  const outline = { color: '#ffffff', width: 3, join: 'round' } as unknown as string;
  player.setComponentsTop(Components.text('{name}', { fill: '#111111', stroke: outline, fontSize: 12, fontWeight: 'bold' }));
}

export async function rejoin(player: RpgPlayer) {
  await ensureStarted();
  const wallet = walletOf(player);
  if (!wallet) return;
  const { dir, matches } = await lobbyRecord();
  nameTag(player, dir.players[wallet]?.username ?? null, wallet);
  const id = liveOf.get(wallet);
  const m = id ? matches[id] : undefined;
  if (m?.phase === 'battle') { absentSince.delete(wallet); openMatch(player, m, sideOf(m, wallet)); }
  // Back while the stakes lock (from the wallet app, say): to the lobby's locking card, not the map.
  else if (m?.phase === 'locking') { absentSince.delete(wallet); await openLobby(player); }
  void collectWhatIsOwed(wallet);
}

// ------------------------------------------------------------------ matches

/** What a staked match tells the lobby and the screens as it moves (src/modules/main/staked.ts). */
const events: StakedEvents = {
  changed: (m) => { void publish(m); void refreshLobby(m.a.wallet); void refreshLobby(m.b.wallet); },
  started: (m) => startBattle(m),
  voided: (m, why) => {
    liveOf.delete(m.a.wallet); liveOf.delete(m.b.wallet);
    for (const side of ['a', 'b'] as const) { notices.set(m[side].wallet, `Match void. ${why} Each locked stake goes back to its owner.`); void refreshLobby(m[side].wallet); }
  },
  resolved: (m) => spendItems(m),
  decided: (m) => { void settle(m); },
};

/**
 * A creature's identity for the program: its DSM anchor, or, for a creature still on its way to
 * the wallet (only ever fielded in a free match), a name derived from its game id.
 */
function anchorOf(c: Creature): Uint8Array {
  if (c.anchor !== null) return fromB32(c.anchor);
  return new Uint8Array(createHash('sha256').update(`wildstate/unissued-creature/v1|${c.id}`).digest());
}

/**
 * A free match's setup: the players' wallets and their own keys (which sign nothing in a free
 * match), the teams as prepared, and start entropy the game draws for each side, since no stake
 * rides on the seed. The program resolves it exactly as it would a staked one.
 */
async function freeSetup(m: Match): Promise<{ setup: Uint8Array; reveals: Reveals }> {
  const reveals: Reveals = { a: new Uint8Array(randomBytes(32)), b: new Uint8Array(randomBytes(32)) };
  const side = async (s: Side) => {
    const id = await walletIdentity(m[s].wallet);
    return {
      genesis: id.genesis, deviceId: id.deviceId, sessionKey: id.signingKey, startCommitment: startCommitment(reveals[s]),
      poultice: m[s].items.poultice, tonic: m[s].items.tonic, team: m[s].team.map((c) => creatureState(c, anchorOf(c))),
    };
  };
  return { setup: encodeSetup(matchNonce(m), await side('a'), await side('b')), reveals };
}

async function begin(aWallet: string, bWallet: string, stake: number) {
  // Read before anything is checked: from the checks to `liveOf` naming the match nothing is
  // awaited, so two begins for one wallet (two challenges accepted at once, an accept and the
  // matchmaker) never both pass and put it in two matches.
  const { dir, matches, save } = await lobbyRecord();
  const pa = playerOfWallet(aWallet), pb = playerOfWallet(bWallet);
  if (!pa || !pb || isFighting(pa) || isFighting(pb) || liveOf.has(aWallet) || liveOf.has(bWallet)) return;
  if (pvpTeam(session(pa).read()).length === 0 || pvpTeam(session(pb).read()).length === 0) return;
  // A lock would only queue behind a request the wallet holds for its player's approval.
  if (stake > 0) {
    const held = ([[pa, aWallet], [pb, bWallet]] as const).find(([p]) => walletWaiting(p));
    if (held) {
      for (const w of [aWallet, bWallet]) { notices.set(w, held[1] === w ? 'Your DSM wallet is waiting for you to approve or decline a request; answer it there first.' : 'Your opponent\'s wallet is waiting on them; try again in a moment.'); void refreshLobby(w); }
      return;
    }
    // Every creature of a staked team is in its wallet: its state is what both wallets check.
    const unissued = ([[pa, aWallet], [pb, bWallet]] as const).find(([p]) => pvpTeam(session(p).read()).some((c) => c.anchor === null));
    if (unissued) {
      deliverUnissued(unissued[0]);
      for (const w of [aWallet, bWallet]) { notices.set(w, unissued[1] === w ? 'A creature on your team is still on its way to your wallet; a staked match waits for it.' : 'Your opponent\'s team is still arriving in their wallet; try again in a moment.'); void refreshLobby(w); }
      return;
    }
  }
  queue.delete(aWallet); queue.delete(bWallet);
  for (const c of challenges.values()) if ([c.from, c.to].some(w => w === aWallet || w === bWallet)) challenges.delete(c.id);
  const id = `pvp/${Date.now().toString(36)}/${serial++}`;
  const entrant = (p: RpgPlayer, wallet: string) => ({ wallet, name: shownName(dir, wallet), team: pvpTeam(session(p).read()), items: session(p).read().inventory });
  const m = lockingMatch(id, stake, entrant(pa, aWallet), entrant(pb, bWallet));
  matches[id] = m;
  befriend(dir, aWallet, bWallet); befriend(dir, bWallet, aWallet);
  liveOf.set(aWallet, id); liveOf.set(bWallet, id);
  save();
  // A staked match starts once both stakes are locked and both wallets readied; the players wait in the lobby.
  if (stake > 0) {
    m.escrow = freshEscrow(matchNonce(m));
    save();
    void refreshLobby(aWallet); void refreshLobby(bWallet);
    void lockMatch(m, events);
    return;
  }
  try {
    const free = await freeSetup(m);
    loadSetup(m, free.setup, free.reveals);
    m.phase = 'battle';
    m.deadline = Date.now() + TURN_MS;
  } catch (err) {
    m.phase = 'void';
    liveOf.delete(aWallet); liveOf.delete(bWallet);
    save();
    for (const w of [aWallet, bWallet]) { notices.set(w, `The match could not start: ${err instanceof Error ? err.message : String(err)}`); void refreshLobby(w); }
    return;
  }
  save();
  startBattle(m);
}

/** Both players into the battle screen. */
function startBattle(m: Match) {
  liveOf.set(m.a.wallet, m.id); liveOf.set(m.b.wallet, m.id);
  // What the lobby said before the match began is behind them now.
  notices.delete(m.a.wallet); notices.delete(m.b.wallet);
  for (const side of ['a', 'b'] as const) {
    const p = playerOfWallet(m[side].wallet);
    if (!p) { absentSince.set(m[side].wallet, Date.now()); continue; }
    absentSince.delete(m[side].wallet);
    p.getGui('lobby')?.close();
    web2(p, 'Match', m.stake
      ? `vs @${m[other(side)].name} for ${m.stake} WILD each: every move signed by your own wallet, the result computed by the program, no referee`
      : `vs @${m[other(side)].name}: a free match, resolved by the same program staked matches are`);
    openMatch(p, m, side);
  }
}

/** Bag items the program spent this turn leave the players' bags too. */
function spendItems(m: Match) {
  for (const entry of m.log) {
    if (!entry.move.startsWith('item:')) continue;
    const p = playerOfWallet(m[entry.side].wallet);
    if (!p) continue;
    try { commit(p, { type: 'consume-item', item: entry.move.slice(5) === 'tonic' ? 'tonic' : 'poultice' }, session(p).read().revision); }
    catch (e) { if (!(e instanceof GameError)) throw e; }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** When a match began, from its id (`pvp/<base-36 ms>/<n>`). */
const startedAt = (m: Match) => parseInt(m.id.split('/')[1] ?? '0', 36) || 0;

/**
 * Whatever a staked match still needs from this wallet now that it is here: its moves (a match
 * waits for an absent player), the winner's settlement and collection, or a void match's stake back.
 */
export async function collectWhatIsOwed(wallet: string) {
  const { matches, save } = await lobbyRecord();
  for (const m of Object.values(matches)) {
    const e = m.escrow;
    if (!e || !('transcript' in e) || (m.a.wallet !== wallet && m.b.wallet !== wallet)) continue;
    if (m.phase === 'battle') { void advance(m, events); continue; }
    if (m.phase === 'done' && !e.paid) { await payOut(m, events); continue; }
    if (m.phase !== 'void') continue;
    // A void match's lock may land after the match gave up on it: look for it for a day, so it goes back.
    if (Date.now() - startedAt(m) < DAY_MS) {
      for (const side of ['a', 'b'] as const) if (m[side].wallet === wallet) await findLateLock(m, side);
      save();
    }
    const owed = (['a', 'b'] as const).some((s) => e[s] && !e.refunded[s]);
    if (owed) await withdrawAndRefund(m, events);
  }
}

function openMatch(player: RpgPlayer, m: Match, side: Side) {
  setFighting(player, true);
  setInMatch(player, true);
  const gui = player.gui('creature-battle');
  gui.on<{ action: string }>('battle', async ({ action }) => {
    const { matches, save } = await lobbyRecord();
    const live = matches[m.id];
    if (!live) return;
    // After a match, players go back to the lobby for the next one, not out to the map.
    if (action === 'continue') {
      if (live.phase === 'battle') return;
      gui.close();
      setFighting(player, false);
      setInMatch(player, false);
      await openLobby(player);
      return;
    }
    if (live.stake > 0) {
      // A staked match: the player's own wallet signs the move (or the resignation).
      if (action === 'escape') void resignStaked(live, side, events);
      else {
        const error = chooseStaked(live, side, action, events);
        if (error) { gui.update({ ...battleView(live, side), error: player.t(`game.error.${error}`) }); return; }
        chosen.set(`${live.id}/${side}`, action);
      }
      save();
      await publish(live);
      return;
    }
    if (action === 'escape') forfeit(live, side);
    else {
      const error = choose(live, side, action, Date.now());
      if (error) { gui.update({ ...battleView(live, side), error: player.t(`game.error.${error}`) }); return; }
      chosen.set(`${live.id}/${side}`, action);
      if (live.a.choice === null && live.b.choice === null) spendItems(live);
    }
    save();
    await publish(live);
  });
  void gui.open(battleView(m, side), { waitingAction: true, blockPlayerInput: true }).finally(() => { setFighting(player, false); setInMatch(player, false); });
}

/** Sends both sides the match as it stands; rates it once it is over. */
async function publish(m: Match) {
  for (const side of ['a', 'b'] as const) {
    const p = playerOfWallet(m[side].wallet);
    p?.getGui('creature-battle')?.update(battleView(m, side));
  }
  if (m.phase === 'done' || (m.phase === 'void' && !m.escrow)) await settle(m);
}

async function settle(m: Match) {
  const { dir, save } = await lobbyRecord();
  // Only while this is still each wallet's match: a staked match is settled again when its payout
  // lands, by when its players may be in their next match.
  for (const w of [m.a.wallet, m.b.wallet]) if (liveOf.get(w) === m.id) { liveOf.delete(w); absentSince.delete(w); }
  if (m.winner === null) { save(); return; }
  const winner = m[m.winner], loser = m[other(m.winner)];
  const pw = (dir.players[winner.wallet] ??= freshProfile()), pl = (dir.players[loser.wallet] ??= freshProfile());
  if (pw.history.some(h => h.matchId === m.id)) return; // rated once per match
  const next = rate(pw, pl);
  const at = Date.now();
  const entry = (p: typeof pw, opponent: string, result: MatchSummary['result'], rating: number) => {
    p.history = [{ matchId: m.id, opponent, stake: m.stake, result, ratingDelta: rating - p.rating, at }, ...p.history].slice(0, HISTORY_MAX);
    p.rating = rating; p.games += 1;
    if (result === 'win') p.wins += 1; else p.losses += 1;
  };
  entry(pw, loser.wallet, 'win', next.winner);
  entry(pl, winner.wallet, 'loss', next.loser);
  save();
  for (const [wallet, won] of [[winner.wallet, true], [loser.wallet, false]] as const) {
    const p = playerOfWallet(wallet);
    if (p) web2(p, won ? 'Match won' : 'Match lost', `vs @${(won ? loser : winner).name} · ${m.reason} · rating ${dir.players[wallet].rating}: ${m.stake ? 'computed by the program from both wallets\' signed moves; the winner\'s wallet settles it' : 'a free match, the game\'s own record'}`);
  }
}

/** Every second: pair the queue, time turns out, resign free-match players who stayed away, lapse old challenges. */
async function tickLobby() {
  const now = Date.now();
  for (const c of challenges.values()) if (now - c.at > CHALLENGE_MS) { challenges.delete(c.id); void refreshLobby(c.from); void refreshLobby(c.to); }
  for (const [a, b] of pair([...queue.values()].filter(t => playerOfWallet(t.wallet)), now)) await begin(a.wallet, b.wallet, a.stake);
  const { matches, save } = await lobbyRecord();
  for (const id of new Set(liveOf.values())) {
    const m = matches[id];
    if (!m || m.phase !== 'battle') continue;
    if (m.stake > 0) {
      // No clock decides a staked match: a player who is here and lets the timer run out has their
      // own wallet seal a pass; one who is away holds the match until they are back.
      if (now >= m.deadline) { for (const s of ['a', 'b'] as const) if (m[s].choice === null) chosen.set(`${m.id}/${s}`, 'pass'); passIfDue(m, now, events); save(); await publish(m); }
      continue;
    }
    const gone = (['a', 'b'] as const).find(s => now - (absentSince.get(m[s].wallet) ?? now) > GRACE_MS);
    if (gone) forfeit(m, gone, now);
    else if (now >= m.deadline) {
      for (const s of ['a', 'b'] as const) if (m[s].choice === null) chosen.set(`${m.id}/${s}`, 'pass');
      expire(m, now);
    } else continue;
    save();
    await publish(m);
  }
  for (const t of queue.values()) void refreshLobby(t.wallet);
  // Every five minutes: stakes a void match still owes players who are here, and late locks for a day.
  if (now - lastSweep > 5 * 60_000) {
    lastSweep = now;
    const owed = new Set(Object.values(matches).filter(m => m.escrow && m.phase === 'void' && now - startedAt(m) < DAY_MS).flatMap(m => [m.a.wallet, m.b.wallet]));
    for (const w of owed) if (playerOfWallet(w)) void collectWhatIsOwed(w);
  }
}
let lastSweep = 0;

/**
 * After a restart: free matches cut off mid-battle are void (nobody's rating moves); a staked match
 * still locking is void, its stakes withdrawn and returned; a staked match under way goes on, and
 * waits for its players to come back.
 */
async function voidStaleMatches() {
  const { matches, save } = await lobbyRecord();
  for (const m of Object.values(matches)) {
    if (m.stake > 0 && m.escrow && 'transcript' in m.escrow && m.phase === 'battle') { liveOf.set(m.a.wallet, m.id); liveOf.set(m.b.wallet, m.id); continue; }
    if (m.phase === 'battle' || m.phase === 'locking') { m.phase = 'void'; m.winner = null; }
  }
  save();
}

export type { Directory };
