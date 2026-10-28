/**
 * DSM underneath the game (DSM Amendment A11).
 *
 * The game stays what it was: walking, encounters and battles run here on
 * the game server and never touch DSM. What a player owns lives in the
 * player's DSM wallet on their phone: WILD, the game's coin, and each caught
 * creature, a state object of supply one. The player connects the wallet
 * once by scanning a code; after that the game asks the wallet for what the
 * player granted (accept a creature, pay for a capsule, quote and swap in the
 * market, prove holdings) with no going back and forth to the phone.
 *
 * Nothing a wallet answers is evidence. The game grants a capsule only when
 * its own account accepted the payment, and takes coins and creatures only
 * from holdings proofs its account verified (`connect.app.status`).
 *
 * The overlay shows both lanes as they happen: what the game server did
 * (Web2) and what DSM did underneath, as the game's account recorded it.
 */
import type { RpgPlayer } from '@rpgjs/server';
import { stateSchema, GameError, SCARECROW_CAPSULES, SKINS, SKIN_NAMES, SPECIES, SHOP_QTY_MAX, TRAINERS, type Skin, displayName, newCreature, initialState, salePrice, transition, type Command, type Creature, type GameState } from '../../domain/game';
import { DsmHost, HostError, b32, fromB32, own, short, type Bytes } from '../../integrations/dsm/host';
import { PROGRAM, anchorBytes, creatureState } from '../../domain/program';
import type { Economy, Login, Species } from '../../integrations/dsm/economy';
import { COIN, ITEM_PRICES, SKIN_PRICE, MARKET, MARKET_VAULTS, TRAINER_REWARD, VICTORY_REWARD, WELCOME_COINS, entered, type ShopItem } from '../../integrations/dsm/terms';
import * as pb from '../../integrations/dsm/proto/dsm_app_pb';

/** The game's DSM account (`dsm-app-host`): the game does not run without it. */
const DSM_HOST_URL: string | undefined = process.env.DSM_APP_HOST;
const RECORD_PATH = process.env.DSM_GAME_RECORD ? process.env.DSM_GAME_RECORD : 'data/dsm-game.json';

// ------------------------------- the overlay -------------------------------

export type Tone = 'info' | 'ok' | 'wait' | 'fail';
export interface OverlayEntry {
  id: number;
  lane: 'web2' | 'dsm';
  title: string;
  detail: string;
  tone: Tone;
  /** How long the step took, seen from the game (Web2 timing, display only). */
  ms?: number;
  dsm?: {
    route: string;
    positionBefore?: string;
    positionAfter?: string;
    econRoot?: string;
    deviceTree?: string;
  };
}

export interface PanelData {
  /** This browser's resume token, for it to keep: reopening the game resumes the connection. */
  resumeToken: string | null;
  entries: OverlayEntry[];
  account: { device: string; storageSet: string; signatureBytes: number } | null;
  wallet: string | null;
  coins: string | null;
  era: string | null;
  provenAt: string | null;
}

/** A WILD amount, as base units of a 0-decimal token. */
const wildText = (n: bigint) => `${n} WILD`;
/** An ERA amount: ERA has two decimals. */
const eraText = (base: bigint) => `${base / 100n}.${String(base % 100n).padStart(2, '0')} ERA`;

// -------------------------------- the world --------------------------------

interface World {
  host: DsmHost;
  economy: Economy;
  meta: pb.AppHostActivityV1;
}

let worldReady: Promise<World> | null = null;
/** Lines said while the game account is set up, shown to every player. */
const setupLines: OverlayEntry[] = [];
let nextEntry = 1;

function entry(lane: OverlayEntry['lane'], title: string, detail: string, tone: Tone, ms?: number): OverlayEntry {
  return { id: nextEntry++, lane, title, detail, tone, ms };
}

export function world(): Promise<World> {
  if (!DSM_HOST_URL) return Promise.reject(new Error('the game was started without DSM_APP_HOST'));
  if (!worldReady) {
    worldReady = (async () => {
      const host = new DsmHost(DSM_HOST_URL as string);
      const meta = await host.activity(0n);
      // Node only: the game's record lives on the game server's disk.
      const { Economy } = await import('../../integrations/dsm/economy');
      const economy = new Economy(host, RECORD_PATH, b32(meta.deviceId));
      await economy.eraRow();
      await economy.setUp((line) => {
        const e = entry('dsm', 'Setting up the game account', line, 'wait');
        setupLines.push(e);
        for (const seat of allSeats()) pushEntries(seat, [e]);
      });
      startActivityPump(host);
      return { host, economy, meta };
    })();
    worldReady.catch((e) => {
      worldReady = null;
      const failed = entry('dsm', 'The game account could not be set up', String(e), 'fail');
      setupLines.push(failed);
      for (const seat of allSeats()) pushEntries(seat, [failed]);
    });
  }
  return worldReady;
}

// --------------------------------- seats ---------------------------------

interface Seat {
  player: RpgPlayer;
  feed: OverlayEntry[];
  session: Bytes | null;
  wallet: string | null;
  offerDigest: string | null;
  coins: bigint | null;
  era: bigint | null;
  provenAt: bigint | null;
  lastWalk: number;
  resumeToken: string | null;
  /** What the wallet is holding for the player's approval: every later request waits behind it. */
  waiting: string | null;
  /** The panel's next update, while one is due. */
  panelDue?: ReturnType<typeof setTimeout>;
}

const seats = new Map<string, Seat>();
const allSeats = () => [...seats.values()];

function seatOf(player: RpgPlayer): Seat {
  let seat = seats.get(player.id);
  if (!seat) {
    seat = {
      player, feed: [...setupLines], session: null, wallet: null, offerDigest: null,
      coins: null, era: null, provenAt: null, lastWalk: 0, resumeToken: null, waiting: null,
    };
    seats.set(player.id, seat);
  }
  return seat;
}

/** A wallet's DSM panel history, kept while its page is away, so coming back does not empty it. */
const feeds = new Map<string, OverlayEntry[]>();

export function leave(player: RpgPlayer): void {
  const seat = seats.get(player.id);
  if (seat?.wallet) feeds.set(seat.wallet, seat.feed);
  seats.delete(player.id);
  gone.delete(player.id);
}

// ------------------------- the wallet leaving the game -------------------------

/** How often every connected wallet's session is checked on the game account. */
const SESSION_CHECK_MS = 5000;
/** What a page does when its wallet's session is gone, by page id (player.ts: back to the connect screen). */
const gone = new Map<string, () => void>();
let sessionWatch: ReturnType<typeof setInterval> | null = null;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A wallet can end its session with the game from its own side (Apps → Wildstate → disconnect).
 * Nothing tells the game; its next request would wait on a session that no longer exists. So
 * every connected wallet's session is checked on the game account, and a page whose session is
 * disconnected, or no longer listed, is handed to `onGone`: there is no game without a wallet.
 */
export function watchWallet(player: RpgPlayer, onGone: () => void): void {
  gone.set(player.id, onGone);
  if (sessionWatch === null) {
    sessionWatch = setInterval(() => { void checkSessions(); }, SESSION_CHECK_MS);
    sessionWatch.unref?.();
  }
}

/** Whether the page's wallet session is held (a request can go over it). */
export const walletConnected = (player: RpgPlayer): boolean => seats.get(player.id)?.session !== null && seats.has(player.id);

/** One read of the account's sessions, checked against every seat; a seat whose session is gone loses it. */
export async function checkSessions(): Promise<void> {
  const watched = allSeats().filter((seat) => seat.session !== null && gone.has(seat.player.id));
  if (!watched.length) return;
  let live: pb.ConnectSessionV1[];
  try { live = (await (await world()).host.sessions()); } catch { return; } // the account unreachable: nothing is decided on that
  for (const seat of watched) {
    const mine = live.find((s) => sameBytes(s.sessionId, seat.session!));
    if (mine && mine.status !== pb.ConnectSessionStatus.DISCONNECTED) continue;
    // The session goes first, so nothing else is asked over it; the wallet's name stays for the
    // page's own leaving (the lobby knows players by wallet), then goes too.
    seat.session = null; seat.offerDigest = null; seat.waiting = null;
    pushEntries(seat, [entry('dsm', 'Wallet disconnected', `Wallet ${seat.wallet ? short(seat.wallet) : '?'} ended its session with the game${mine ? '' : ' (the session is no longer on the game account)'}: back to the connect screen`, 'fail')]);
    gone.get(seat.player.id)?.();
    seat.wallet = null;
  }
}

/** The wallet session a request goes over. A page that has just come back may not have it yet. */
function sessionOf(seat: Seat): Bytes {
  if (!seat.session) throw new Error('Your wallet is reconnecting; try again in a moment.');
  return seat.session;
}

/** What the player's wallet holds for their approval, if anything: nothing else moves until it is answered. */
export function walletWaiting(player: RpgPlayer): string | null {
  return seats.get(player.id)?.waiting ?? null;
}

/**
 * A page that comes back with its game already loaded (the phone switched to the wallet app and
 * back, or the network dropped) still has its wallet's session on the game's account: the
 * connection the wallet approved outlives the page's socket. Pick it up again, so requests keep
 * going over it. Otherwise the wallet must connect afresh: 'disconnected' when the wallet ended
 * its session while the page was away (on a phone, disconnecting means leaving the page for the
 * wallet app, so the session check never saw it), 'none' when there is no session to pick up.
 */
export async function resumeWallet(player: RpgPlayer, holder: string): Promise<'resumed' | 'disconnected' | 'none'> {
  const seat = seatOf(player);
  if (seat.session && seat.wallet === holder) return 'resumed';
  const w = await world();
  const mine = (await w.host.sessions()).filter((s) => b32(s.peerDeviceId) === holder);
  const live = mine
    .filter((s) => s.status !== pb.ConnectSessionStatus.DISCONNECTED && grantIsCurrent(s, w))
    // The one in use most recently: the wallet answers on every session it approved.
    .sort((a, b) => (a.lastSeq < b.lastSeq ? 1 : a.lastSeq > b.lastSeq ? -1 : 0));
  if (!seats.has(player.id)) return 'none';
  const kept = feeds.get(holder);
  if (kept) { seat.feed = kept; feeds.delete(holder); }
  if (!live.length) {
    const ended = mine.some((s) => s.status === pb.ConnectSessionStatus.DISCONNECTED);
    if (ended) pushEntries(seat, [entry('dsm', 'Wallet disconnected', `Wallet ${short(holder)} ended its session with the game while the page was away: back to the connect screen`, 'fail')]);
    return ended ? 'disconnected' : 'none';
  }
  seat.session = own(live[0].sessionId);
  seat.wallet = holder;
  seat.offerDigest = b32(live[0].offerDigest);
  pushEntries(seat, [entry('web2', 'Connection resumed', `The page came back; it goes on with wallet ${short(holder)}'s session. Nothing about DSM changed`, 'ok')]);
  proveLater(player);
  return 'resumed';
}

function panel(seat: Seat): PanelData {
  const meta = worldMeta;
  return {
    resumeToken: seat.resumeToken,
    entries: seat.feed.slice(-PANEL_ENTRIES),
    account: meta
      ? { device: b32(meta.deviceId), storageSet: b32(meta.storageSetId), signatureBytes: meta.signatureBytes }
      : null,
    wallet: seat.wallet,
    coins: seat.coins === null ? null : wildText(seat.coins),
    era: seat.era === null ? null : eraText(seat.era),
    provenAt: seat.provenAt === null ? null : String(seat.provenAt),
  };
}

/** How many of the newest entries the panel shows. */
const PANEL_ENTRIES = 60;
/** The account's own activity reaches the panel at most this often: a busy account adds some every second. */
const PANEL_EVERY_MS = 2000;

/**
 * Entries into the panel. What the game did for this player shows at once; the account's activity
 * stream (`soon`) shows with the next update due, so a busy account never sends every phone the
 * whole panel every second.
 */
function pushEntries(seat: Seat, entries: OverlayEntry[], soon?: 'soon'): void {
  seat.feed.push(...entries);
  if (seat.feed.length > 400) seat.feed.splice(0, seat.feed.length - 400);
  if (soon === undefined) {
    if (seat.panelDue !== undefined) { clearTimeout(seat.panelDue); seat.panelDue = undefined; }
    seat.player.getGui('dsm-panel')?.update(panel(seat));
    return;
  }
  if (seat.panelDue !== undefined) return;
  seat.panelDue = setTimeout(() => {
    seat.panelDue = undefined;
    seat.player.getGui('dsm-panel')?.update(panel(seat));
  }, PANEL_EVERY_MS);
  seat.panelDue.unref?.();
}

/** A Web2 event: something the game server did on its own. */
export function web2(player: RpgPlayer, title: string, detail: string, tone: Tone = 'info'): void {
  pushEntries(seatOf(player), [entry('web2', title, detail, tone)]);
}

/**
 * Walking is Web2: said once a session. Every entry sends the phone the whole panel to draw again,
 * and one every six seconds of walking was a full panel on the phone that moves the player
 * (phones, 2026-10-08).
 */
export function walked(player: RpgPlayer): void {
  const seat = seatOf(player);
  if (seat.lastWalk !== 0) return;
  seat.lastWalk = Date.now();
  web2(player, 'Walking', 'Movement runs on the phone and the game server, and never touches DSM');
}

/** The panel, open beside the game. Its toggle is the player's, on the client. */
export function openPanel(player: RpgPlayer): void {
  const seat = seatOf(player);
  const gui = player.gui('dsm-panel');
  void gui.open(panel(seat));
}

// ---------------------- the host's record, as it happens ----------------------

let worldMeta: pb.AppHostActivityV1 | null = null;

/** Whether the game's account answered the last read, and since when it has not. */
let hostDownSince: number | null = null;

/**
 * Log every time the server's one thread was blocked long enough for players to feel it: what
 * moves players stops while it is (phones, 2026-10-08: walking paused, then went on).
 */
function watchForStalls(): void {
  const EVERY_MS = 500;
  let expected = performance.now() + EVERY_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = Math.round(now - expected);
    if (late >= 250) console.warn(`[stall] the server was blocked for ${late} ms`);
    expected = now + EVERY_MS;
  }, EVERY_MS);
  timer.unref?.();
}

function startActivityPump(host: DsmHost): void {
  watchForStalls();
  let after = 0n;
  const tick = async () => {
    try {
      const feed = await host.activity(after);
      worldMeta = feed;
      if (hostDownSince !== null) {
        const back = entry('dsm', 'The game account is back', 'Its record continues where it stopped', 'ok', Date.now() - hostDownSince);
        for (const seat of allSeats()) pushEntries(seat, [back]);
        hostDownSince = null;
      }
      if (feed.entries.length > 0) {
        after = feed.entries[feed.entries.length - 1].seq;
        const entries = feed.entries.map(dsmEntry);
        for (const seat of allSeats()) pushEntries(seat, entries, 'soon');
      }
    } catch (e) {
      // One line per outage, not one per read.
      if (hostDownSince === null) {
        hostDownSince = Date.now();
        const failed = entry('dsm', 'The game account is unreachable', String(e), 'fail');
        for (const seat of allSeats()) pushEntries(seat, [failed]);
      }
    }
    setTimeout(tick, 1000);
  };
  void tick();
}

/**
 * `ask`, once the game's account answers. While it is away (a fetch that
 * never reached it) the screen says so and the game waits; when it answers
 * again the screen shows `shown` once more. A refusal from the account is
 * not an absence: it is thrown.
 */
async function whenReachable<T>(
  player: RpgPlayer,
  gui: { update: (data: object) => void },
  shown: () => object,
  ask: () => Promise<T>,
): Promise<T> {
  let missed = 0;
  for (;;) {
    try {
      const answer = await ask();
      if (missed > 0) gui.update(shown());
      return answer;
    } catch (e) {
      if (!(e instanceof TypeError) || !seats.has(player.id)) throw e;
      missed += 1;
      gui.update({ ...shown(), status: `The game account is unreachable (${e.message}); waiting for it.` });
      await sleep(2000);
    }
  }
}

function dsmEntry(e: pb.AppHostActivityEntryV1): OverlayEntry {
  const failed = e.error.length > 0;
  const moved = e.positionBefore !== undefined && e.positionAfter !== undefined && e.positionAfter !== e.positionBefore;
  return {
    id: nextEntry++,
    lane: 'dsm',
    title: e.kind === pb.AppHostActivityKind.RELAY ? `${e.name}` : `${e.name}`,
    detail: [e.summary, failed ? e.error : e.result].filter((x) => x.length > 0).join(' → '),
    tone: failed ? 'fail' : moved ? 'ok' : 'info',
    dsm: {
      route: e.name,
      positionBefore: e.positionBefore === undefined ? undefined : String(e.positionBefore),
      positionAfter: e.positionAfter === undefined ? undefined : String(e.positionAfter),
      econRoot: e.econRootAfter.length ? short(e.econRootAfter) : undefined,
      deviceTree: e.deviceTreeAfter.length ? short(e.deviceTreeAfter) : undefined,
    },
  };
}

// ------------------------------- connecting -------------------------------

/** What the game asks a wallet for, once, at connect. */
function scopes(w: World): pb.ConnectScopeV1[] {
  const wild = w.economy.wild;
  const era = w.economy.eraCommit;
  const cap = (policyCommit: Bytes, perRequest: bigint, total: bigint) =>
    new pb.ConnectCapV1({ policyCommit, perRequest, total });
  return [
    new pb.ConnectScopeV1({ kind: pb.ConnectScopeKind.ACCEPT_ISSUED }),
    // Limits high enough that ordinary play never stops for an approval: a request past
    // one waits in the wallet, and the wallet holds every later request behind it.
    new pb.ConnectScopeV1({ kind: pb.ConnectScopeKind.PAY, caps: [cap(wild, 1_000n, 100_000n)] }),
    new pb.ConnectScopeV1({
      kind: pb.ConnectScopeKind.SWAP,
      policyCommits: [wild, era],
      caps: [cap(wild, 100_000n, 1_000_000n), cap(era, 1_000_000n, 10_000_000n)],
    }),
    new pb.ConnectScopeV1({ kind: pb.ConnectScopeKind.HOLDINGS, policyCommits: [wild, era] }),
    // Staked matches the pinned program decides (SoFi S22): up to 1,000 WILD a match and 10,000 in
    // all without asking, only in matches of this program; a bigger stake waits for the player.
    // Moves, readies, settling and collecting spend nothing and run under the grant.
    new pb.ConnectScopeV1({ kind: pb.ConnectScopeKind.DUEL, caps: [cap(wild, 1_000n, 10_000n)], programs: [own(PROGRAM)] }),
    // Which of the wallet's contacts are here, as DSM IDs only, for FRIENDS (DSM Amendment A16).
    new pb.ConnectScopeV1({ kind: pb.ConnectScopeKind.CONTACTS }),
  ];
}

/**
 * Whether a session's grant covers everything the game's offer asks now: each scope, with at least
 * its limits. A grant from an older offer (lower limits, no stakes) is connected afresh, once, so
 * play never stops for an approval the current offer would not need.
 */
function grantIsCurrent(session: pb.ConnectSessionV1, w: World): boolean {
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  return scopes(w).every((offered) => session.granted.some((g) => g.kind === offered.kind
    && offered.caps.every((c) => g.caps.some((gc) => same(gc.policyCommit, c.policyCommit) && gc.perRequest >= c.perRequest && gc.total >= c.total))
    && offered.programs.every((p) => g.programs.some((gp) => same(gp, p)))));
}

/**
 * Show the player a connect code and wait for their wallet. Resolves once the
 * wallet accepted and the game's account added it as a contact.
 */
/** The login token each player's page was last shown, by player id: what a reloaded page goes on with. */
const shownTo = new Map<string, string>();

export async function connectWallet(player: RpgPlayer, bound: (state: GameState) => void, reason = ''): Promise<void> {
  const seat = seatOf(player);
  openPanel(player);
  const gui = player.gui('dsm-connect');
  // A page that comes back (from the wallet app, which the phone brings to the
  // front, or a reload) sends the login token it was given with its code.
  let offered: string | null = null;
  gui.on<{ token?: unknown }>('resume', ({ token }) => {
    if (typeof token === 'string') offered = token;
  });
  const shown = { code: '', status: 'Setting up the game account on DSM…', resumeToken: null as string | null };
  void gui.open(shown, { blockPlayerInput: true });
  const w = await world();
  // A page the phone reloaded on its way back from the wallet is the same player (its id is kept
  // in the browser): it goes on with the code it showed, whether or not its token arrives in time.
  offered ??= shownTo.get(player.id) ?? null;
  // Give a returning page a moment to send its token before making a new offer.
  for (let i = 0; i < 10 && offered === null; i++) await sleep(200);

  let sessions = await whenReachable(player, gui, () => shown, () => w.host.sessions());
  const held = (login: Login) =>
    sessions.find((s) => s.status !== pb.ConnectSessionStatus.DISCONNECTED
      && ((login.session !== null && b32(s.sessionId) === login.session) || b32(s.offerDigest) === login.offer)
      // An older grant does not resume: the page shows a fresh code for the current offer.
      && (s.offerDigest.length === 0 || grantIsCurrent(s, w) || (login.session === null && b32(s.offerDigest) === login.offer)));

  /** The login this page goes on with: the one it brought, or a new offer and token. */
  const loginFor = async (token: string | null): Promise<[string, Login]> => {
    const brought = token === null ? undefined : w.economy.record.resume[token];
    if (token !== null && brought !== undefined && brought.offer !== '' && (brought.session === null || held(brought))) {
      if (brought.session === null) {
        // The code shown before: the player may be approving it in the wallet now.
        const offer = await whenReachable(player, gui, () => shown, () => w.host.offerOf(fromB32(brought.offer)));
        shown.code = offer.code;
      }
      return [token, brought];
    }
    if (token !== null && brought !== undefined && brought.session !== null && held(brought)) return [token, brought];
    const offer = await whenReachable(player, gui, () => shown, () => w.host.offer('Wildstate', scopes(w), [w.economy.wild]));
    const fresh = b32(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const login: Login = { offer: b32(offer.offerDigest), session: null };
    w.economy.record.resume[fresh] = login;
    w.economy.save();
    shown.code = offer.code;
    web2(player, 'Connect code shown', 'The game server asked its DSM account for an offer and shows its code');
    return [fresh, login];
  };

  let [token, login] = await loginFor(offered);
  shownTo.set(player.id, token);
  const resumedSession = login.session;
  seat.offerDigest = login.offer;
  seat.resumeToken = token;
  shown.resumeToken = token;
  shown.status = `${reason}${reason ? ' ' : ''}Scan this with your DSM wallet: Apps → SCAN CODE.`;
  gui.update(shown);
  const started = Date.now();
  for (;;) {
    const mine = held(login);
    if (mine) {
      seat.session = own(mine.sessionId);
      seat.wallet = b32(mine.peerDeviceId);
      if (login.session === null) {
        login.session = b32(mine.sessionId);
        w.economy.save();
      }
      break;
    }
    if (!seats.has(player.id)) return;
    await sleep(500);
    // A token that arrived late names the code this page showed before.
    if (offered !== null && offered !== token && w.economy.record.resume[offered] !== undefined) {
      [token, login] = await loginFor(offered);
      shownTo.set(player.id, token);
      seat.offerDigest = login.offer;
      seat.resumeToken = token;
      shown.resumeToken = token;
      gui.update(shown);
    }
    sessions = await whenReachable(player, gui, () => shown, () => w.host.sessions());
  }
  pushEntries(seat, [
    resumedSession !== null && resumedSession === login.session
      ? entry('web2', 'Connection resumed', `This browser's game login resumed the session with wallet ${short(seat.wallet!)}; nothing about DSM changed`, 'ok', Date.now() - started)
      : entry('dsm', 'Wallet connected', `Wallet ${short(seat.wallet!)} approved the grant; the game account added it as a contact`, 'ok', Date.now() - started),
  ]);
  void gui.close();
  const known = w.economy.record.profiles[seat.wallet!];
  const profile = known ?? initialState(seat.wallet!);
  bound(profile);
  web2(player, 'Profile loaded', `The game's own record for wallet ${short(seat.wallet!)}: progress, HP and XP are game data`);
  // Every creature not yet issued, then every object the account issued and still holds: a
  // delivery a restart or a lost session cut off goes on from where it stopped.
  for (const c of profile.creatures.filter((c) => c.anchor === null)) {
    enqueue(player, `Delivering ${displayName(c)}`, () => deliverCreature(player, c.id, c.species));
  }
  enqueue(player, 'Resuming deliveries', async () => {
    for (const anchor of await onTheWay(player)) {
      const issued = w.economy.record.creatures[anchor];
      enqueue(player, `Delivering ${SPECIES[issued.species].name} #${issued.serial}`, () => handOver(player, anchor));
    }
  });
  enqueue(player, 'Finding your friends', () => refreshContacts(player));
  const holder = seat.wallet!;
  if (!w.economy.record.welcomed.includes(holder)) {
    enqueue(player, 'Paying your starting coin', async () => {
      // Asked again when it runs: a wallet that connected twice before the first payment was
      // through has two of these queued, one after the other, and only the first pays.
      if (w.economy.record.welcomed.includes(holder)) return;
      await payReward(player, holder, WELCOME_COINS, 'welcome');
      w.economy.record.welcomed.push(holder);
      w.economy.save();
    });
  }
  if (w.economy.record.owed[holder]?.length) enqueue(player, 'Paying what the game owes you', () => payOwed(player, holder));
  proveLater(player);
}

// ---------------------------------- tasks ----------------------------------

type Commit = (player: RpgPlayer, command: Command) => GameState;
let commitFn: Commit | null = null;
/** How a DSM task changes the game state: through the reducer, like any command. */
export function useCommit(commit: Commit): void {
  commitFn = commit;
}

function commit(player: RpgPlayer, command: Command): GameState {
  if (!commitFn) throw new Error('the game state is not wired to DSM tasks');
  const next = commitFn(player, command);
  const seat = seatOf(player);
  if (seat.wallet) {
    void world().then((w) => {
      w.economy.record.profiles[seat.wallet!] = { ...next, scarecrowReadyAt: Math.max(next.scarecrowReadyAt, w.economy.record.profiles[seat.wallet!]?.scarecrowReadyAt ?? 0) };
      w.economy.save();
    });
  }
  return next;
}

/** Keep the player's profile in the game's record after any command. */
export function persist(player: RpgPlayer, state: GameState): void {
  const seat = seats.get(player.id);
  if (!seat?.wallet) return;
  void world().then((w) => {
    w.economy.record.profiles[seat.wallet!] = { ...state, scarecrowReadyAt: Math.max(state.scarecrowReadyAt, w.economy.record.profiles[seat.wallet!]?.scarecrowReadyAt ?? 0) };
    w.economy.save();
  });
}

/** Free game items, timed by the game server and persisted per connected wallet. */
export async function claimScarecrowGift(player: RpgPlayer): Promise<number> {
  const seat = seatOf(player);
  if (!seat.wallet) throw new Error('Connect your wallet before collecting capsules.');
  const w = await world();
  const current = readState(player);
  const stored = w.economy.record.profiles[seat.wallet];
  const latest = stored && stored.revision > current.revision ? stateSchema.parse(stored) : current;
  const readyAt = Math.max(current.scarecrowReadyAt, stored?.scarecrowReadyAt ?? 0);
  const now = Date.now();
  if (now < readyAt) return readyAt - now;
  player.creatureSave.set(JSON.stringify({ ...latest, scarecrowReadyAt: readyAt }));
  const next = commit(player, { type: 'scarecrow-gift', now });
  // No await between checking the shared profile and installing the result: two sessions
  // for the same wallet cannot both claim. Save before showing the gift dialogue.
  w.economy.record.profiles[seat.wallet] = next;
  w.economy.save();
  for (const other of allSeats()) if (other.wallet === seat.wallet && other.player !== player) {
    other.player.creatureSave.set(JSON.stringify(next));
    other.player.getGui('field-hud')?.update(hudData(other.player));
    other.player.getGui('creature-battle')?.update({ state: next, mode: 'battle', lastAction: 'sync', error: '' });
  }
  web2(player, 'Scarecrow gift', `${SCARECROW_CAPSULES} free capture capsules; next gift in four hours. Game items, no WILD issued.`);
  return 0;
}

/**
 * DSM work runs one task at a time per wallet (not per connection): two pages of one wallet must
 * never send over the same relationship at once.
 */
const walletQueues = new Map<string, Promise<void>>();
function enqueue(player: RpgPlayer, title: string, task: () => Promise<void>): void {
  const seat = seatOf(player);
  const key = seat.wallet ?? `seat/${player.id}`;
  const run = (walletQueues.get(key) ?? Promise.resolve()).then(async () => {
    const started = Date.now();
    try {
      await task();
    } catch (e) {
      // Shown in the DSM panel, and in the server's log; the field stays clear.
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[task] ${key.slice(0, 8)} ${title}: not done: ${why}`);
      pushEntries(seat, [entry('web2', `${title}: not done`, why, 'fail', Date.now() - started)]);
    }
  });
  walletQueues.set(key, run);
}

// --------------------------------- lobby ---------------------------------

/**
 * Queue the delivery of every creature of `player`'s that is not in its wallet yet: what a staked
 * match waits for, asked again when the match finds it missing rather than only at the next
 * connect. A delivery that already ran finds its creature issued and does nothing more.
 */
export function deliverUnissued(player: RpgPlayer): void {
  for (const c of readState(player).creatures.filter((c) => c.anchor === null)) {
    enqueue(player, `Delivering ${displayName(c)}`, () => deliverCreature(player, c.id, c.species));
  }
}

/** The connected wallet's DSM identity (Base32), or null before it connects. */
export function walletOf(player: RpgPlayer): string | null {
  return seats.get(player.id)?.wallet ?? null;
}
/** The connected player of a wallet, if one is online. */
export function playerOfWallet(wallet: string): RpgPlayer | null {
  return allSeats().find((s) => s.wallet === wallet && s.session !== null)?.player ?? null;
}
/** The lobby's records, kept in the game's own record (Web2 game data, never DSM evidence). */
export async function lobbyRecord() {
  const w = await world();
  return {
    dir: { players: w.economy.record.players, usernames: w.economy.record.usernames },
    matches: w.economy.record.matches,
    save: () => w.economy.save(),
  };
}

let hudData: (player: RpgPlayer) => Record<string, unknown> = () => ({});
export function useHudData(f: (player: RpgPlayer) => Record<string, unknown>): void {
  hudData = f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How often a request's status is read. `answer`: the status is a stored answer until the wallet
 * replies, cheap to read, so it is read often while a reply is likely soon. `sync`: each read takes
 * in the account's inbox first. `walk`: each read walks the vaults of a match's verdict cell.
 */
type Pace = 'answer' | 'sync' | 'walk';
const SETTLE_DEADLINE_MS = 6 * 60_000;
function pause(pace: Pace, elapsed: number): number {
  if (pace === 'walk') return 1000;
  if (pace === 'sync') return 1000;
  return elapsed < 10_000 ? 300 : elapsed < 60_000 ? 800 : 1500;
}

/** Poll request `seq` until `done`, saying once when it waits for the player. */
async function settle(
  player: RpgPlayer,
  seq: bigint,
  done: (s: pb.ConnectAppStatusV1) => boolean,
  what: string,
  onWaiting?: () => void,
  pace: Pace = 'answer',
): Promise<pb.ConnectAppStatusV1> {
  // The request's own session: a page that drops and comes back mid-wait gets a fresh seat.
  const session = sessionOf(seatOf(player));
  const w = await world();
  const seat = seatOf(player);
  let saidWaiting = false;
  const began = Date.now();
  let lastSeen = '';
  try {
    while (Date.now() - began < SETTLE_DEADLINE_MS) {
      const s = await w.host.status(session, seq);
      const seen = `${s.answered ? 'answered' : 'unanswered'} ${pb.ConnectOutcome[s.outcome]}${s.reason ? ` (${s.reason.slice(0, 120)})` : ''}`;
      if (seen !== lastSeen) { console.log(`[settle] ${what} #${seq} +${Date.now() - began} ms: ${seen}`); lastSeen = seen; }
      if (done(s)) {
        console.log(`[settle] ${what} #${seq} done in ${Date.now() - began} ms`);
        // Once more, into the record (what the account established), off the player's path.
        void w.host.status(session, seq, true).catch(() => {});
        return s;
      }
      if (s.answered && (s.outcome === pb.ConnectOutcome.FAILED || s.outcome === pb.ConnectOutcome.DECLINED)) {
        throw new Error(`${what}: the wallet answered ${pb.ConnectOutcome[s.outcome]}${s.reason ? ` (${s.reason})` : ''}`);
      }
      if (!saidWaiting && s.outcome === pb.ConnectOutcome.AWAITING_APPROVAL) {
        saidWaiting = true;
        seat.waiting = `${what}${s.reason ? `: ${s.reason}` : ''}`;
        web2(player, `${what}: waiting for you`, 'Past what you approved: approve or decline it in your DSM wallet (Apps → Waiting)', 'wait');
        player.getGui('field-hud')?.update(hudData(player));
        onWaiting?.();
      }
      await sleep(pause(pace, Date.now() - began));
    }
    throw new Error(`${what}: still not settled; it stays pending`);
  } finally {
    if (saidWaiting) { seat.waiting = null; player.getGui('field-hud')?.update(hudData(player)); }
  }
}

/**
 * An online transfer from the game's account to wallet `to`, retried while its relationship
 * settles. `to` is named by the caller, never read off the page: a page can connect another wallet
 * while what the first one earned (or accepted) is still on its way.
 */
async function sendFromGame(player: RpgPlayer, to: string, ticker: string, amount: string, memo: string): Promise<void> {
  const w = await world();
  for (let round = 0; ; round++) {
    try {
      await w.host.send(fromB32(to), ticker, amount, memo);
      return;
    } catch (e) {
      const settling = e instanceof HostError && /not send-ready|pending online transition/.test(e.message);
      if (!settling || round >= 40) throw e;
      if (round === 0) web2(player, 'Waiting to send', 'The relationship with your wallet is settling a previous transfer', 'wait');
      // Take in the wallet's countersign now, as the account's inbox poller would.
      await w.host.sync();
      await sleep(500);
    }
  }
}

/** A caught creature becomes a state object in the player's wallet. */
async function deliverCreature(player: RpgPlayer, creatureId: string, species: Species): Promise<void> {
  const w = await world();
  const started = Date.now();
  // Looked at when the delivery runs, not when it was queued: a page that connected again, or a
  // second page of the wallet, queued it once more, and one creature is one object.
  if (readState(player).creatures.find((c) => c.id === creatureId)?.anchor !== null) return;
  const already = Object.keys(w.economy.record.creatures).find((a) => w.economy.record.creatures[a].creature === creatureId);
  if (already !== undefined) {
    // Issued for it before (by another page, or before this one went away): this page knows it by that object.
    commit(player, { type: 'bind-creature', creatureId, anchor: already });
    return;
  }
  const anchor = await w.economy.issueCreature(species, (line) => web2(player, 'Game account', line, 'wait'), creatureId);
  commit(player, { type: 'bind-creature', creatureId, anchor });
  await handOver(player, anchor, started);
  // The state it was issued in, published as its first record: what wallets read it against before a staked match.
  const issued = readState(player).creatures.find((c) => c.id === creatureId);
  if (issued) await publishedState(issued);
}

/**
 * Objects the game's account issued for this player's creatures and still holds: on their way
 * to the wallet. The account's own balances say so, not the game's record of what it meant to do.
 */
async function onTheWay(player: RpgPlayer): Promise<string[]> {
  const w = await world();
  const held = new Set((await w.host.balances()).filter((b) => b.available === 1n).map((b) => b.policyAnchorB32));
  // An object the account holds again after its creature left a party (its game data kept in
  // `stats`) came back to it: Bramble bought it. It is the game's, on its way to nobody, whatever
  // an older page of the wallet that sold it still shows.
  return readState(player).creatures.flatMap((c) =>
    c.anchor !== null && w.economy.record.creatures[c.anchor] !== undefined && held.has(c.anchor) && w.economy.record.stats[c.anchor] === undefined ? [c.anchor] : [],
  );
}

/** An issued creature object goes to the player's wallet: the wallet roots it, then the account sends it. */
async function handOver(player: RpgPlayer, anchor: string, started = Date.now()): Promise<void> {
  const w = await world();
  const seat = seatOf(player);
  const issued = w.economy.record.creatures[anchor];
  const species = issued.species;
  const what = `${SPECIES[species].name} #${issued.serial} (${short(anchor)})`;
  // The wallet asked to accept it is the one it goes to, whatever the page connects meanwhile.
  const wallet = seat.wallet!;
  // One object goes out once. Claimed before anything is awaited: two wallets' tasks never both send it.
  if (handingOver.has(anchor)) throw new Error(`${what} is already being handed over; it is not sent twice`);
  handingOver.add(anchor);
  try {
    // The account sends only what it holds: an object it already gave away is never retried.
    if (!(await w.host.balances()).some((b) => b.policyAnchorB32 === anchor && b.available === 1n)) {
      throw new Error(`The game account no longer holds ${what}: it was handed over already, so it is not sent again`);
    }
    const seq = await w.host.request(sessionOf(seat), {
      case: 'acceptIssued',
      value: new pb.ConnectAcceptIssuedV1({ anchor: fromB32(anchor) }),
    });
    await settle(player, seq, (s) => s.answered && s.outcome === pb.ConnectOutcome.CARRIED_OUT, 'Accepting the creature');
    await sendFromGame(player, wallet, issued.ticker, '1', `${SPECIES[species].name} #${issued.serial}`);
  } finally {
    handingOver.delete(anchor);
  }
  // Sent: it stays in the party until a proof shows the wallet holding it.
  w.economy.record.inFlight[wallet] = [...(w.economy.record.inFlight[wallet] ?? []), anchor];
  w.economy.save();
  pushEntries(seat, [
    entry('dsm', `${SPECIES[species].name} #${issued.serial} delivered`, `State object ${short(anchor)}: supply 1, issued by the game account, now in wallet ${short(wallet)}`, 'ok', Date.now() - started),
  ]);
  proveLater(player);
}
/** Creature objects being handed over now, by anchor. */
const handingOver = new Set<string>();

/** A victory's reward: WILD from the game's account. */
async function payReward(player: RpgPlayer, to: string, amount: bigint, why: string): Promise<void> {
  const started = Date.now();
  await sendFromGame(player, to, COIN.ticker, String(amount), why);
  pushEntries(seatOf(player), [entry('dsm', `${why[0].toUpperCase()}${why.slice(1)}: ${wildText(amount)}`, 'An online transfer from the game account to your wallet', 'ok', Date.now() - started)]);
  proveLater(player);
}

/** WILD the game owes `to`, in its record before anything is sent: nothing earned is lost to a failed transfer. */
function owe(w: World, to: string, amount: bigint, why: string): void {
  w.economy.record.owed[to] = [...(w.economy.record.owed[to] ?? []), { amount: String(amount), why }];
  w.economy.save();
}
/** Everything the game owes `to`, each cleared once sent. A failed transfer stays owed, for the next time the wallet is here. */
async function payOwed(player: RpgPlayer, to: string): Promise<void> {
  const w = await world();
  for (let debt = w.economy.record.owed[to]?.[0]; debt !== undefined; debt = w.economy.record.owed[to]?.[0]) {
    await payReward(player, to, BigInt(debt.amount), debt.why);
    w.economy.record.owed[to] = (w.economy.record.owed[to] ?? []).filter((d) => d !== debt);
    w.economy.save();
  }
}

const ITEM_NAMES: Record<ShopItem, string> = { capsule: 'Capture Capsule', poultice: 'Herb Poultice', tonic: 'Charge Tonic', map: 'Ranger’s Map' };
/** Bramble's lines after a purchase and after a sale, as the design's Shop page has them. */
const BRAMBLE = { bought: 'Capsules go fast after a meadow rush. Stock up.', sold: 'Selling a creature transfers it for good. Think it over.', skin: 'Suits you. Wear it from your bag, and swap back whenever you like.' };

/** `n` items from Bramble's board in one payment from the wallet, granted only once the game's account accepted it. */
async function buyItem(player: RpgPlayer, item: ShopItem, n: number): Promise<void> {
  const w = await world();
  const seat = seatOf(player);
  const started = Date.now();
  const cost = ITEM_PRICES[item] * BigInt(n);
  const what = `${n} × ${ITEM_NAMES[item]}`;
  refusedBeforeDsm(player, { type: 'grant-item', item, qty: n, fact: 'not yet paid' }, what);
  const seq = await w.host.request(sessionOf(seat), {
    case: 'pay',
    value: new pb.ConnectPayV1({ policyCommit: w.economy.wild, amount: cost, memo: what.toLowerCase() }),
  });
  const paid = await settle(player, seq, (s) => s.fact === pb.ConnectFact.PAID, `Paying for ${what.toLowerCase()}`,
    () => shopShow(player, { status: 'Approve the payment on your phone: Apps → Waiting' }), 'sync');
  commit(player, { type: 'grant-item', item, qty: n, fact: new TextDecoder().decode(paid.paidTx) });
  // The wallet paid: show the balance the proof will confirm, so the board does not lag behind the purchase.
  if (seat.coins !== null) seat.coins -= cost;
  pushEntries(seat, [entry('dsm', `${what} paid: ${wildText(cost)}`, 'Granted on the transfer the game account accepted, never on the wallet\'s word', 'ok', Date.now() - started)]);
  shopShow(player, { busy: false, status: `${what} in your bag · ${wildText(cost)} paid from your wallet`, say: BRAMBLE.bought, delta: `-${cost}`, deltaAt: Date.now() });
  player.getGui('field-hud')?.update(hudData(player));
  proveLater(player);
}

/** A Halloween skin from Bramble, in one payment from the wallet, granted only once the game's account accepted it. */
async function buySkin(player: RpgPlayer, skin: Skin): Promise<void> {
  const w = await world();
  const seat = seatOf(player);
  const started = Date.now();
  const what = `the ${SKIN_NAMES[skin]} skin`;
  // Owned already: refused here, before the wallet is asked for anything.
  refusedBeforeDsm(player, { type: 'grant-skin', skin, fact: 'not yet paid' }, `Buying ${what}`);
  const seq = await w.host.request(sessionOf(seat), {
    case: 'pay',
    value: new pb.ConnectPayV1({ policyCommit: w.economy.wild, amount: SKIN_PRICE, memo: `${SKIN_NAMES[skin].toLowerCase()} skin` }),
  });
  const paid = await settle(player, seq, (s) => s.fact === pb.ConnectFact.PAID, `Paying for ${what}`,
    () => shopShow(player, { status: 'Approve the payment on your phone: Apps → Waiting' }), 'sync');
  commit(player, { type: 'grant-skin', skin, fact: new TextDecoder().decode(paid.paidTx) });
  if (seat.coins !== null) seat.coins -= SKIN_PRICE;
  pushEntries(seat, [entry('dsm', `${SKIN_NAMES[skin]} skin paid: ${wildText(SKIN_PRICE)}`, 'Granted on the transfer the game account accepted, never on the wallet\'s word', 'ok', Date.now() - started)]);
  shopShow(player, { busy: false, status: `${SKIN_NAMES[skin]} skin in your bag · ${wildText(SKIN_PRICE)} paid from your wallet`, say: BRAMBLE.skin, delta: `-${SKIN_PRICE}`, deltaAt: Date.now() });
  player.getGui('field-hud')?.update(hudData(player));
  proveLater(player);
}

/**
 * A creature for Bramble: its state object moves from the wallet to the game's account, then
 * the game's account pays for it. The grant covers paying WILD, not handing over a creature,
 * so the wallet asks the player on the phone; the sale counts once the account accepted the object.
 */
async function sellCreature(player: RpgPlayer, creatureId: string): Promise<void> {
  const w = await world();
  const seat = seatOf(player);
  // The wallet that hands the creature over is the one paid for it.
  const wallet = seat.wallet!;
  const started = Date.now();
  const c = readState(player).creatures.find((x) => x.id === creatureId);
  if (!c) throw new Error('That creature is not in your party');
  if (c.anchor === null) throw new Error(`${displayName(c)} is still on its way to your wallet`);
  const anchor = c.anchor;
  const name = displayName(c);
  const price = BigInt(salePrice(c));
  refusedBeforeDsm(player, { type: 'sell', creatureId, fact: 'not yet handed over' }, `Selling ${name}`);
  const seq = await w.host.request(sessionOf(seat), {
    case: 'pay',
    value: new pb.ConnectPayV1({ policyCommit: fromB32(anchor), amount: 1n, memo: `${name} to Bramble` }),
  });
  const paid = await settle(player, seq, (s) => s.fact === pb.ConnectFact.PAID, `Handing ${name} to Bramble`,
    () => shopShow(player, { status: 'Approve the sale on your phone: Apps → Waiting' }), 'sync');
  // Its game data stays with its object, as for any creature that leaves a party. Bramble holds it
  // from here, so its price is owed before the game state is asked (which a change made while the
  // player approved, say a new lead, can refuse): a refused state never leaves it unpaid.
  w.economy.record.stats[anchor] = c;
  owe(w, wallet, price, `Bramble bought ${name}`);
  commit(player, { type: 'sell', creatureId, fact: new TextDecoder().decode(paid.paidTx) });
  shopShow(player, { status: `${name} is Bramble’s now · paying ${wildText(price)}…` });
  await payOwed(player, wallet);
  pushEntries(seat, [entry('dsm', `Sold ${name}: ${wildText(price)}`, `Its state object ${short(anchor)} reached the game account, which paid for it`, 'ok', Date.now() - started)]);
  shopShow(player, { busy: false, status: `${name} sold · ${wildText(price)} on its way to your wallet`, say: BRAMBLE.sold, delta: `+${price}`, deltaAt: Date.now() });
  player.getGui('field-hud')?.update(hudData(player));
  proveLater(player);
}

/**
 * What the game state would refuse (the lead or last creature for sale, a second map) is refused
 * before the wallet pays or hands anything over, never after.
 */
function refusedBeforeDsm(player: RpgPlayer, command: Command, what: string): void {
  const now = readState(player);
  try {
    transition(now, now.revision, `${now.holder}/before-dsm`, command);
  } catch (e) {
    if (e instanceof GameError) throw new Error(`${what}: the game refuses it (${e.code}); nothing was asked of your wallet`);
    throw e;
  }
}

/** What Bramble's screen shows besides the game state: the step DSM is on and his last line. */
interface ShopView { busy: boolean; status: string; say: string; delta: string; deltaAt: number }
const shopViews = new Map<string, ShopView>();
const quietShop = (): ShopView => ({ busy: false, status: '', say: '', delta: '', deltaAt: 0 });
function shopData(player: RpgPlayer) {
  return { state: readState(player), coins: walletCoins(player), ...(shopViews.get(player.id) ?? quietShop()) };
}
function shopShow(player: RpgPlayer, change: Partial<ShopView>): void {
  const view = shopViews.get(player.id);
  if (!view) return;
  shopViews.set(player.id, { ...view, ...change });
  player.getGui('bramble-shop')?.update(shopData(player));
}
/** A task that reports its failure on Bramble's screen as well as in the panel. */
function shopTask(player: RpgPlayer, title: string, task: () => Promise<void>): void {
  enqueue(player, title, async () => {
    try { await task(); }
    catch (e) { shopShow(player, { busy: false, status: `${title}: ${e instanceof Error ? e.message : String(e)}` }); throw e; }
  });
}

/** Bramble's Trading Post, open until the player leaves it. */
export async function openShop(player: RpgPlayer): Promise<void> {
  if (!seatOf(player).session) return;
  shopViews.set(player.id, { ...quietShop(), status: 'Prices in WILD, paid from your DSM wallet' });
  const gui = player.gui('bramble-shop');
  gui.on<{ action: string; item?: string; qty?: number; creatureId?: string; skin?: string }>('shop', ({ action, item, qty, creatureId, skin }) => {
    if (action === 'leave') { gui.close(); return; }
    if (shopViews.get(player.id)?.busy) return;
    if (action === 'buy' && item !== undefined && item in ITEM_PRICES) {
      const it = item as ShopItem;
      const n = Math.max(1, Math.min(SHOP_QTY_MAX, Math.floor(Number(qty) || 1)));
      shopShow(player, { busy: true, say: '', status: `Asking your wallet for ${wildText(ITEM_PRICES[it] * BigInt(n))}…` });
      web2(player, 'Bramble’s board', `${n} × ${ITEM_NAMES[it]}: the game asks your wallet for the payment`);
      shopTask(player, `Buying ${n} × ${ITEM_NAMES[it].toLowerCase()}`, () => buyItem(player, it, n));
    }
    if (action === 'buy-skin' && skin !== undefined && (SKINS as readonly string[]).includes(skin)) {
      const sk = skin as Skin;
      shopShow(player, { busy: true, say: '', status: `Asking your wallet for ${wildText(SKIN_PRICE)}…` });
      web2(player, 'Bramble’s board', `The ${SKIN_NAMES[sk]} skin: the game asks your wallet for the payment`);
      shopTask(player, `Buying the ${SKIN_NAMES[sk].toLowerCase()} skin`, () => buySkin(player, sk));
    }
    if (action === 'sell' && creatureId) {
      shopShow(player, { busy: true, say: '', status: 'Asking your wallet to hand the creature to Bramble…' });
      web2(player, 'Bramble’s board', 'A sale: the creature’s state object goes to the game account, which pays for it');
      shopTask(player, 'Selling a creature', () => sellCreature(player, creatureId));
    }
  });
  web2(player, 'Trading post', 'Bramble’s prices are game data; paying and selling are DSM');
  await gui.open(shopData(player), { waitingAction: true, blockPlayerInput: true });
  shopViews.delete(player.id);
}
/** The wallet balance as the game last saw it (a proof, adjusted by payments since). */
export function walletCoins(player: RpgPlayer): number | null {
  const c = seats.get(player.id)?.coins ?? null;
  return c === null ? null : Number(c);
}

/**
 * Ask for a fresh holdings proof after an action, as a task of its own: the
 * action is done once DSM did it, whatever the proof that follows finds.
 */
function proveLater(player: RpgPlayer): void {
  // One waiting proof answers for every action before it: a second one queued behind it would
  // only hold the wallet, which answers in order, from the player's next request.
  const seat = seatOf(player);
  const key = seat.wallet ?? `seat/${player.id}`;
  if (proofsQueued.has(key)) return;
  proofsQueued.add(key);
  enqueue(player, 'Proving your holdings', () => {
    proofsQueued.delete(key);
    return refreshHoldings(player);
  });
}
/** Wallets with a holdings proof queued that has not started yet. */
const proofsQueued = new Set<string>();

/** The anchors the game asks about: its coin, ERA, and every creature it issued. */
function holdingsAsked(w: World): Bytes[] {
  return [w.economy.wild, w.economy.eraCommit, ...Object.keys(w.economy.record.creatures).map(fromB32)];
}

/** Verified holdings: coins and the roster follow the wallet. */
async function refreshHoldings(player: RpgPlayer): Promise<void> {
  const w = await world();
  const seat = seatOf(player);
  const asked = holdingsAsked(w);
  // What the account still holds for this player, read while the wallet proves its side.
  const onWay = onTheWay(player);
  onWay.catch(() => {});
  // A proof the wallet's next position overtook before the account read it proves nothing:
  // the wallet is asked again, at its new position.
  let s: pb.ConnectAppStatusV1 | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const seq = await w.host.request(sessionOf(seat), {
      case: 'holdings',
      value: new pb.ConnectHoldingsV1({ policyCommits: asked }),
    });
    s = await settle(player, seq, (x) => x.fact === pb.ConnectFact.HOLDINGS || (x.answered && x.fact === pb.ConnectFact.NONE && x.factDetail.startsWith('the proof established nothing')), 'Proving holdings');
    if (s.fact === pb.ConnectFact.HOLDINGS || !s.factDetail.includes('NotCurrent')) break;
    await sleep(300);
  }
  if (s!.fact !== pb.ConnectFact.HOLDINGS) throw new Error(s!.factDetail);
  const amounts = new Map(s!.holdings.map((h) => [b32(h.policyCommit), h.amount]));
  seat.coins = amounts.get(b32(w.economy.wild)) ?? 0n;
  seat.era = amounts.get(b32(w.economy.eraCommit)) ?? 0n;
  seat.provenAt = s!.holdingsPosition;
  const held = Object.keys(w.economy.record.creatures).filter((a) => (amounts.get(a) ?? 0n) === 1n);
  const sent = (w.economy.record.inFlight[seat.wallet!] ?? []).filter((a) => !held.includes(a));
  w.economy.record.inFlight[seat.wallet!] = sent;
  const inFlight = [...sent, ...(await onWay).filter((a) => !held.includes(a))];
  const before = readState(player);
  // Creatures that left with their object keep their game data in the record.
  for (const c of before.creatures) {
    if (c.anchor !== null && !held.includes(c.anchor) && !inFlight.includes(c.anchor)) w.economy.record.stats[c.anchor] = c;
  }
  commit(player, { type: 'holdings', coins: Number(seat.coins), held, inFlight });
  for (const anchor of held) {
    if (readState(player).creatures.some((c) => c.anchor === anchor)) continue;
    const issued = w.economy.record.creatures[anchor];
    const known = w.economy.record.stats[anchor];
    const creature: Creature = known ?? { ...newCreature(`${anchor}/creature`, issued.species), anchor };
    commit(player, { type: 'receive-creature', creature });
    web2(player, `${SPECIES[issued.species].name} #${issued.serial} joined`, 'Its state object reached your wallet from another player', 'ok');
  }
  w.economy.save();
  const sentLine = inFlight.length > 0 ? `; ${inFlight.length} on the way, not in this proof yet` : '';
  pushEntries(seat, [entry('dsm', 'Holdings proven', `${wildText(seat.coins)}, ${eraText(seat.era)}, ${held.length} creature object(s)${sentLine}, at wallet position ${s!.holdingsPosition}: verified against the wallet's economic root`, 'ok')]);
  player.getGui('field-hud')?.update(hudData(player));
  await openMarkets.get(player.id)?.();
}

let readState: (player: RpgPlayer) => GameState = () => {
  throw new Error('the game state is not wired to DSM tasks');
};
export function useReadState(f: (player: RpgPlayer) => GameState): void {
  readState = f;
}

// --------------------------- game events and tasks ---------------------------

/** What a committed command means underneath. */
export function onCommitted(player: RpgPlayer, command: Command, before: GameState, after: GameState): void {
  persist(player, after);
  const battle = after.battle;
  switch (command.type) {
    case 'encounter':
      web2(player, 'Encounter', `A wild ${SPECIES[battle!.wild.species].name} appeared: rolled by the game server`);
      break;
    case 'cast':
      web2(player, 'Fishing', `A ${SPECIES[battle!.wild.species].name} took the line: rolled by the game server`);
      break;
    case 'set-lead':
      web2(player, 'New lead', `${displayName(after.creatures[after.lead])} leads the party: game data, no DSM`);
      break;
    case 'rename':
      web2(player, 'Renamed', 'A nickname is game data: the creature\'s DSM object is unchanged');
      break;
    case 'move': {
      const log = battle?.log ?? [];
      web2(player, 'Battle turn', log.map((l) => `${l.actor === 'own' ? 'You' : 'Wild'}: ${l.move}${l.dmg ? ` ${l.dmg} dmg` : ''}`).join(' · ') + ': computed by the game server, no DSM');
      break;
    }
    case 'escape':
      web2(player, 'Escaped', 'No reward, nothing on DSM');
      break;
    case 'challenge':
      web2(player, 'Trainer battle', `${TRAINERS[command.trainer].name} sends out ${displayName(battle!.wild)}: run by the game server, no DSM`);
      break;
    case 'use-item':
      web2(player, 'Item used', `${command.item} on ${displayName(after.creatures.find((c) => c.id === command.creatureId)!)}: HP and charges are game data, no DSM`);
      break;
    case 'grant-item':
      break;
    case 'heal':
      web2(player, 'Rested at camp', 'HP and charges are game data: no DSM');
      break;
    default:
      break;
  }
  const finished = before.battle?.outcome === 'active' && battle && battle.outcome !== 'active';
  if (finished && battle!.outcome === 'victory' && battle!.source === 'trainer') {
    const t = TRAINERS[battle!.trainer!];
    web2(player, `${t.name} beaten`, `The game decides the bounty (${wildText(TRAINER_REWARD)}); the game account pays it as a transfer`);
    // To the wallet whose game won it (its state's holder), whatever the page connects by the time it is paid.
    void world().then((w) => {
      owe(w, after.holder, TRAINER_REWARD, `bounty from ${t.name}`);
      enqueue(player, `Paying ${t.name}'s bounty`, () => payOwed(player, after.holder));
    });
  } else if (finished && battle!.outcome === 'victory') {
    web2(player, 'Victory', 'The game decides the reward; the game account pays it as a transfer');
    void world().then((w) => {
      owe(w, after.holder, VICTORY_REWARD, 'victory reward');
      enqueue(player, 'Paying the reward', () => payOwed(player, after.holder));
    });
  }
  if (finished && battle!.outcome === 'captured') {
    const caught = after.creatures[after.creatures.length - 1];
    web2(player, 'Captured', `${displayName(caught)} joins your party: the game issues it as a state object in your wallet`);
    enqueue(player, 'Delivering the creature', () => deliverCreature(player, caught.id, caught.species));
  }
}

// --------------------------------- market ---------------------------------

export interface MarketData {
  /** The market's reserves, summed over its vaults as each reports them, and how many were read. */
  vault: { wild: string; era: string; generation: string; vaults: number } | null;
  coins: string | null;
  era: string | null;
  quote: { side: 'buy' | 'sell'; amountIn: string; amountOut: string; hops: number } | null;
  status: string;
  /** What the market is waiting on the wallet for; its button stays held down until the answer. */
  busy: 'quote' | 'swap' | null;
  /** What the wallet holds for the player's approval, if anything. */
  waiting: string | null;
}

async function vaultReading(): Promise<MarketData['vault']> {
  const w = await world();
  const lanes = new Set((w.economy.record.market?.lanes ?? []).filter((lane): lane is string => lane !== null));
  const read = (await w.host.vaults()).filter((v) => lanes.has(b32(v.vaultId)));
  if (read.length === 0) return null;
  let wild = 0n;
  let era = 0n;
  let generation = 0n;
  for (const vault of read) {
    const wildIsA = b32(vault.tokenAPolicyCommit) === b32(w.economy.wild);
    wild += wildIsA ? vault.reserveA : vault.reserveB;
    era += wildIsA ? vault.reserveB : vault.reserveA;
    generation += vault.generation;
  }
  return { wild: entered(wild, 0), era: entered(era, 2), generation: String(generation), vaults: read.length };
}

/** An open market's redraw, by player: a holdings proof that lands while it is open shows in it. */
const openMarkets = new Map<string, () => Promise<void>>();

/**
 * The vault as last read, shared by every open market. A reading walks the account's vaults
 * (seconds), so no screen waits on one: each shows the last reading, and a fresh one redraws them
 * all when it lands. Reads in flight are shared.
 */
const vaultSeen: { value: MarketData['vault']; unread: string; at: number } = { value: null, unread: '', at: 0 };
let vaultRead: Promise<void> | null = null;
const VAULT_FRESH_MS = 15_000;
function readVault(): Promise<void> {
  vaultRead ??= vaultReading()
    .then((v) => { vaultSeen.value = v; vaultSeen.unread = ''; })
    .catch((e) => { vaultSeen.unread = ` The vault could not be read: ${e instanceof Error ? e.message : String(e)}`; })
    .then(async () => {
      vaultSeen.at = Date.now();
      vaultRead = null;
      for (const redraw of openMarkets.values()) await redraw().catch(() => {});
    });
  return vaultRead;
}

export async function openMarket(player: RpgPlayer): Promise<void> {
  const seat = seatOf(player);
  sessionOf(seat);
  const gui = player.gui('dsm-market');
  let quote: MarketData['quote'] = null;
  let shownStatus = '';
  let busy: MarketData['busy'] = null;
  // What the market shows now: the vault as last read (a vault that could not be read is said so).
  const data = (status: string): MarketData => {
    shownStatus = status;
    return {
      vault: vaultSeen.value,
      coins: seat.coins === null ? null : wildText(seat.coins),
      era: seat.era === null ? null : eraText(seat.era),
      quote,
      status: status + vaultSeen.unread,
      busy,
      waiting: seat.waiting,
    };
  };
  openMarkets.set(player.id, async () => gui.update(data(shownStatus)));
  gui.on<{ action: string; side?: 'buy' | 'sell'; amount?: string }>('market', async ({ action, side, amount }) => {
    if (action === 'close') { openMarkets.delete(player.id); void gui.close(); return; }
    // Whatever goes wrong underneath (a wallet that has not answered, a host out of reach) is
    // the market's to say: it must never take the game server down with it.
    // One question to the wallet at a time: a second tap while one waits would only queue behind it.
    if (busy) return;
    try { await marketAction(action, side, amount); }
    catch (e) { busy = null; gui.update(data(e instanceof Error ? e.message : String(e))); }
  });
  const marketAction = async (action: string, side: 'buy' | 'sell' | undefined, amount: string | undefined) => {
    const w = await world();
    const buy = side === 'buy';
    // Buying WILD spends ERA (two decimals); selling WILD spends WILD (none).
    const amountIn = buy ? BigInt(Math.round(Number(amount) * 100)) : BigInt(Math.round(Number(amount)));
    if (!(amountIn > 0n)) { gui.update(data('Enter an amount.')); return; }
    const [tokenIn, tokenOut] = buy ? [w.economy.eraCommit, w.economy.wild] : [w.economy.wild, w.economy.eraCommit];
    if (action === 'quote') {
      busy = 'quote';
      gui.update(data('Pricing the swap through SoFi…'));
      // A price is information read from the vaults' public state: the game's own account finds it,
      // at once. Only the swap, which moves the player's coins, goes to their wallet (and waits there
      // behind whatever the wallet is still taking in).
      web2(player, 'Market', 'Quote: the game prices the swap through SoFi from the vaults\' public state');
      const entered = buy ? `${amountIn / 100n}.${String(amountIn % 100n).padStart(2, '0')}` : String(amountIn);
      const q = await w.host.findRoute(tokenIn, tokenOut, entered);
      busy = null;
      if (q.hops.length === 0) { gui.update(data('No route between WILD and ERA right now.')); return; }
      quote = { side: buy ? 'buy' : 'sell', amountIn: buy ? eraText(q.amountIn) : wildText(q.amountIn), amountOut: buy ? wildText(q.amountOut) : eraText(q.amountOut), hops: q.hops.length };
      gui.update(data(`Quote: ${quote.amountIn} → ${quote.amountOut} over ${q.hops.length} hop(s). Information only.`));
      return;
    }
    if (action === 'swap') {
      const started = Date.now();
      busy = 'swap';
      gui.update(data('Your wallet is trading through SoFi…'));
      web2(player, 'Market', 'Swap: the game asks your wallet to trade; the wallet runs an ordinary SoFi trade');
      const seq = await w.host.request(sessionOf(seat), { case: 'swap', value: new pb.ConnectSwapV1({ tokenIn, tokenOut, amountIn, minAmountOut: 1n }) });
      try {
        const s = await settle(player, seq, (x) => x.answered && x.outcome === pb.ConnectOutcome.CARRIED_OUT, 'Swap', () => { gui.update(data('Your DSM wallet is waiting for you to approve this swap.')); });
        const position = s.swap?.position ?? 0n;
        pushEntries(seat, [entry('dsm', 'Swap realized', `SoFi trade through the WILD/ERA vault at wallet position ${position}; the vault's own record shows it`, 'ok', Date.now() - started)]);
        proveLater(player);
        // The trade moved the vault: every open market shows its new reserves when read.
        void readVault();
        quote = null;
        busy = null;
        gui.update(data(`Swapped. Realized at position ${position}.`));
      } catch (e) {
        busy = null;
        gui.update(data(e instanceof Error ? e.message : String(e)));
      }
    }
  };
  // Open at once; the vault's reading (a few seconds from the account) fills in when it lands.
  const greeting = `Swap WILD and ERA with the game's market: ${MARKET_VAULTS} vaults, ${MARKET.feeBps} bps each.`;
  shownStatus = greeting;
  const opened = gui.open(data(greeting), { waitingAction: true, blockPlayerInput: true });
  if (Date.now() - vaultSeen.at > VAULT_FRESH_MS) void readVault();
  await opened;
}

// ------------------------- computed matches (SoFi S22) -------------------------
//
// A staked match is decided by the pinned program, not by the game: each player's wallet locks its
// stake in a computed escrow vault whose terms its wallet builds from the setup, both wallets ready
// once they verified both vaults (the second writes the Start), every move is an entry the
// player's own wallet signs under its session key, and the winner's wallet settles the transcript
// at the match cell and collects both stakes. Nobody signs a verdict. The game relays the setup
// and the signed entries between the wallets; whatever it relays, each wallet checks itself, and
// every fact the game acts on is one its own account read from DSM.

/** A wallet as the game's account knows it from the card its accept carried. */
async function partyOf(wallet: string): Promise<pb.ConnectSessionV1> {
  const w = await world();
  const known = (await w.host.sessions()).filter(
    (s) => b32(s.peerDeviceId) === wallet && s.status !== pb.ConnectSessionStatus.DISCONNECTED && s.peerGenesis.length === 32,
  );
  if (!known.length) throw new Error(`the game's account holds no connection with wallet ${short(wallet)}`);
  return known[known.length - 1];
}

/** A connected wallet's identity: its genesis, device id and signing key, from its card. */
export async function walletIdentity(wallet: string): Promise<{ genesis: Bytes; deviceId: Bytes; signingKey: Bytes }> {
  const s = await partyOf(wallet);
  return { genesis: own(s.peerGenesis), deviceId: own(s.peerDeviceId), signingKey: own(s.peerSigningKey) };
}

/** The result a wallet answered with, from its signed answer as the game's account verified it. */
function answered(s: pb.ConnectAppStatusV1): pb.AppResponseBodyV1['result'] {
  if (!s.answerBody.length) throw new Error('the wallet answered nothing to relay');
  return pb.AppResponseBodyV1.fromBinary(s.answerBody).result;
}
const carried = (s: pb.ConnectAppStatusV1) => s.answered && s.outcome === pb.ConnectOutcome.CARRIED_OUT;

/** Each wallet's contacts as it last shared them (DSM Amendment A16), by wallet: game data, never evidence. */
const contactsOf = new Map<string, string[]>();

/** The DSM IDs `wallet` last shared as its contacts, or none before it has. */
export function walletContacts(wallet: string): string[] {
  return contactsOf.get(wallet) ?? [];
}

/**
 * Ask `player`'s wallet which of its contacts are who, once its grant covers it: a request outside
 * the grant would wait in the wallet for the player and hold every later request behind it.
 */
export async function refreshContacts(player: RpgPlayer): Promise<void> {
  const w = await world();
  const seat = seatOf(player);
  const session = sessionOf(seat);
  const wallet = seat.wallet;
  if (!wallet) return;
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const granted = (await w.host.sessions()).find((s) => same(s.sessionId, session))?.granted ?? [];
  if (!granted.some((g) => g.kind === pb.ConnectScopeKind.CONTACTS)) return;
  const seq = await w.host.request(session, { case: 'contacts', value: new pb.ConnectContactsV1() });
  const r = answered(await settle(player, seq, carried, 'Finding your friends'));
  if (r.case !== 'contacts') throw new Error(`the wallet answered ${r.case} for its contacts`);
  contactsOf.set(wallet, r.value.contacts.map((c) => b32(c.deviceId)));
}

/** `player`'s wallet's session public key for the match whose setup carries `nonce`. */
export async function sessionKey(player: RpgPlayer, nonce: Bytes): Promise<Bytes> {
  const w = await world();
  const seq = await w.host.request(sessionOf(seatOf(player)), {
    case: 'duelSessionKey', value: new pb.ConnectDuelSessionKeyV1({ matchNonce: nonce }),
  });
  const s = await settle(player, seq, carried, 'Naming your battle key');
  const r = answered(s);
  if (r.case !== 'duelSessionKey') throw new Error(`the wallet answered ${r.case} for its battle key`);
  return own(r.value.sessionPublicKey);
}

/**
 * `player`'s wallet's proof that it holds exactly `anchors` (its fielded creatures), as its wallet
 * signed it: relayed to the opponent's wallet, which verifies it itself before it locks. Asked
 * again while the wallet's latest position is still being admitted.
 */
export async function holdingsProof(player: RpgPlayer, anchors: Bytes[]): Promise<pb.HoldingsProofV1> {
  const w = await world();
  for (let attempt = 0; ; attempt++) {
    const seq = await w.host.request(sessionOf(seatOf(player)), { case: 'holdings', value: new pb.ConnectHoldingsV1({ policyCommits: anchors }) });
    try {
      const s = await settle(player, seq, carried, 'Proving your team');
      const r = answered(s);
      if (r.case !== 'holdings') throw new Error(`the wallet answered ${r.case} for its team`);
      return r.value;
    } catch (err) {
      // A proof waits for a position still being admitted (a lock just made, say): ask again.
      if (attempt >= 20 || !(err instanceof Error) || !err.message.includes('still being admitted')) throw err;
      await sleep(500);
    }
  }
}

/**
 * Ask `player`'s wallet to lock `stake` WILD in the match `setup` describes, playing `side`; side B
 * names side A's vault. `opponentHoldings` is the opponent's proof of its team, relayed. Resolves with
 * the vault and the match cell once the game's own account found the vault Active under exactly the
 * setup's terms.
 */
export async function lockDuel(
  player: RpgPlayer, setup: Bytes, side: 'a' | 'b', stake: number, opponent: string, opponentHoldings: pb.HoldingsProofV1, counterpartVault?: string,
): Promise<{ vault: string; cell: string }> {
  const seat = seatOf(player);
  const w = await world();
  const them = await partyOf(opponent);
  const started = Date.now();
  web2(player, 'Stake', `The game asks your wallet to lock ${stake} WILD in a match the program decides; your wallet checks the setup and both teams itself`);
  const seq = await w.host.request(sessionOf(seat), {
    case: 'duelLock',
    value: new pb.ConnectDuelLockV1({
      setup, side: side === 'a' ? 1 : 2, policyCommit: w.economy.wild, amount: BigInt(stake),
      opponentGenesis: them.peerGenesis, opponentDeviceId: them.peerDeviceId,
      counterpartVaultId: counterpartVault ? fromB32(counterpartVault) : new Uint8Array(),
      memo: `Wildstate match: ${stake} WILD`,
      opponentHoldings,
    }),
  });
  const s = await settle(player, seq, (x) => x.fact === pb.ConnectFact.DUEL_LOCKED, 'Locking your stake', undefined, 'walk');
  const vault = b32(s.escrowVaultIds[0]);
  pushEntries(seat, [entry('dsm', 'Stake locked', `${stake} WILD in computed escrow vault ${short(vault)}, on the match's cell; the game's account walked it`, 'ok', Date.now() - started)]);
  proveLater(player);
  return { vault, cell: b32(s.escrowVerdictCell) };
}

/**
 * Ask `player`'s wallet to ready for the match on `cell`: it verifies both vaults and signs its ready.
 * With the other side's ready, it writes the Start: `started` once the account read the Start there.
 */
export async function readyDuel(player: RpgPlayer, cell: string, opponentReady?: Bytes): Promise<{ readySignature: Bytes; started: boolean }> {
  const w = await world();
  const seq = await w.host.request(sessionOf(seatOf(player)), {
    case: 'duelReady', value: new pb.ConnectDuelReadyV1({ matchCell: fromB32(cell), opponentReady: opponentReady ?? new Uint8Array() }),
  });
  const second = opponentReady !== undefined;
  const s = await settle(player, seq, (x) => (second ? x.fact === pb.ConnectFact.DUEL_STARTED : carried(x)), 'Readying for the match', undefined, second ? 'walk' : 'answer');
  const r = answered(s);
  if (r.case !== 'duelReady') throw new Error(`the wallet answered ${r.case} to its ready`);
  return { readySignature: own(r.value.readySignature), started: s.fact === pb.ConnectFact.DUEL_STARTED };
}

/**
 * Ask `player`'s wallet to withdraw from the match on `cell` before any Start: void, both refunded.
 * What holds the start cell, as the game's account read it: a Withdraw, or a Start that came first.
 */
export async function withdrawDuel(player: RpgPlayer, cell: string): Promise<'withdrawn' | 'started'> {
  const w = await world();
  const seq = await w.host.request(sessionOf(seatOf(player)), {
    case: 'duelWithdraw', value: new pb.ConnectDuelWithdrawV1({ matchCell: fromB32(cell) }),
  });
  // A Withdraw that comes after a Start holds nothing: the account reads the start cell either way.
  const s = await settle(player, seq, (x) => x.fact === pb.ConnectFact.DUEL_WITHDRAWN || x.fact === pb.ConnectFact.DUEL_STARTED, 'Withdrawing from the match', undefined, 'walk');
  return s.fact === pb.ConnectFact.DUEL_STARTED ? 'started' : 'withdrawn';
}

/** One signed entry of a transcript, as the game relays it. */
export interface Relayed { entry: Bytes; signature: Bytes }
const signedEntries = (entries: Relayed[]) => entries.map((e) => new pb.ConnectDuelSignedEntryV1({ entry: e.entry, signature: e.signature }));

/**
 * Ask `player`'s wallet to sign `entry`, its next entry of the match on `cell`, after the other
 * side's signed entries it has not seen (`preceding`). Nothing is written to storage.
 */
export async function signEntry(player: RpgPlayer, cell: string, preceding: Relayed[], entry: Bytes): Promise<{ index: number; signature: Bytes }> {
  const w = await world();
  const seq = await w.host.request(sessionOf(seatOf(player)), {
    case: 'duelSign', value: new pb.ConnectDuelSignV1({ matchCell: fromB32(cell), preceding: signedEntries(preceding), entry }),
  });
  const s = await settle(player, seq, carried, 'Signing your move');
  const r = answered(s);
  if (r.case !== 'duelSign') throw new Error(`the wallet answered ${r.case} to a move`);
  return { index: r.value.index, signature: own(r.value.signature) };
}

/**
 * Ask `player`'s wallet to settle the match on `cell` with the other side's entries it has not
 * seen: it writes the transcript to the match cell. Resolves with the outcome the account read there.
 */
export async function settleDuel(player: RpgPlayer, cell: string, entries: Relayed[]): Promise<string> {
  const w = await world();
  const seq = await w.host.request(sessionOf(seatOf(player)), {
    case: 'duelSettle', value: new pb.ConnectDuelSettleV1({ matchCell: fromB32(cell), entries: signedEntries(entries) }),
  });
  const s = await settle(player, seq, (x) => x.fact === pb.ConnectFact.DUEL_SETTLED, 'Settling the match', undefined, 'walk');
  pushEntries(seatOf(player), [entry('dsm', 'Match settled by the program', `The transcript holds the match cell; the program computes ${new TextDecoder().decode(s.duelCells?.outcome ?? new Uint8Array())}. No referee signed anything`, 'ok')]);
  return new TextDecoder().decode(s.duelCells?.outcome ?? new Uint8Array());
}

/** Ask `player`'s wallet to collect `vaults`: it releases each only to itself, under the match's final outcome. */
export async function collectDuel(player: RpgPlayer, vaults: string[], what: string): Promise<void> {
  const seat = seatOf(player);
  const w = await world();
  const started = Date.now();
  const seq = await w.host.request(sessionOf(seat), {
    case: 'duelCollect', value: new pb.ConnectDuelCollectV1({ vaultIds: vaults.map(fromB32) }),
  });
  await settle(player, seq, (x) => x.fact === pb.ConnectFact.ESCROW_RELEASED, what, undefined, 'walk');
  pushEntries(seat, [entry('dsm', what, `Escrow vault${vaults.length > 1 ? 's' : ''} ${vaults.map(short).join(', ')} released to your wallet under the outcome the program computed`, 'ok', Date.now() - started)]);
  proveLater(player);
}

/**
 * The vault `wallet` locked for the match `setup` describes, found among every request the game's
 * account made of that wallet: a lock can land after its match gave up on it (it waited behind a
 * request the player had not answered), and this is how such a stake is found and given back.
 */
export async function lockedFor(wallet: string, setup: Bytes): Promise<{ vault: string; cell: string } | null> {
  const w = await world();
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const found = await Promise.all((await w.host.sessions()).filter((s) => b32(s.peerDeviceId) === wallet).map(async (session) => {
    const payload = await w.host.query('connect.app.requests', new pb.ConnectAppRequestsQueryV1({ sessionId: session.sessionId, after: 0n }).toBinary());
    if (payload.case !== 'connectReply' || payload.value.reply.case !== 'requests') return [];
    const locks = payload.value.reply.value.requests
      .map((request) => pb.AppRequestBodyV1.fromBinary(request.body))
      .filter((body) => body.kind.case === 'duelLock' && same(body.kind.value.setup, setup));
    const statuses = await Promise.all(locks.map((body) => w.host.status(session.sessionId, body.seq)));
    return statuses.filter((status) => status.fact === pb.ConnectFact.DUEL_LOCKED && status.escrowVaultIds.length)
      .map((status) => ({ vault: b32(status.escrowVaultIds[0]), cell: b32(status.escrowVerdictCell) }));
  }));
  return found.flat()[0] ?? null;
}

// ------------------------- creature states (anti-mod) -------------------------
//
// Each creature's state is published by the game's account as it is when it matters: the state it
// was issued in, then a successor naming the record before it whenever a creature that changed is
// fielded in a staked match. They are generic DSM objects (authored, signed by the account, under
// a locator the creature's anchor names); both wallets read the chain from issuance before they
// lock, and a setup whose creature differs by one byte from its latest record is refused.

/** The creature's latest published state, publishing it first when its game state moved on. */
export async function publishedState(c: Creature): Promise<Bytes> {
  if (c.anchor === null) throw new Error(`${displayName(c)} is still on its way to its wallet`);
  const w = await world();
  return own(await w.economy.publishState(c.anchor, creatureState(c, anchorBytes(c))));
}
