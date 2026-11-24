import { openLobby } from './lobby';
import { graphicOf, isCurrentAvatar } from './presence';
import { npcPosition, pauseNpc } from './patrol';
import { type RpgPlayer } from '@rpgjs/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameError, LOOKS, SKINS, SCARECROW_CAPSULES, SPECIES, TRAINERS, displayName, type Command, type Look, type Skin } from '../../domain/game';
import { session } from './journey';
import { portraitDialogue, talkToRowan, readWayfindingSign, isSpeaking } from './dialogue';
import { gameReportList, readBulletinBoard } from './board';
import { claimScarecrowGift, onCommitted, openMarket, openShop, useCommit, useHudData, useReadState, walked, walletCoins, walletWaiting, web2 } from './dsm';
const inside = new WeakSet<RpgPlayer>();
const proximity = new WeakMap<RpgPlayer, string>();
const fighting = new WeakSet<RpgPlayer>();
/** A player in a battle or a match: field actions wait until it ends. */
export const isFighting = (player: RpgPlayer) => fighting.has(player);
export function setFighting(player: RpgPlayer, on: boolean) { if (on) fighting.add(player); else fighting.delete(player); }
const inArena = new WeakSet<RpgPlayer>();
/**
 * A player in the arena's lobby: the map under it starts no encounter (phones, 2026-10-08: a
 * player's taps on the lobby walked their character into the meadow beneath it, and a wild
 * creature appeared while the lobby was still on screen).
 */
export function setInArena(player: RpgPlayer, on: boolean) { if (on) inArena.add(player); else inArena.delete(player); }
const inMatch = new WeakSet<RpgPlayer>();
/**
 * A player in a player-vs-player match. Its screen shows the match's own snapshot of both teams
 * (lobby.ts), never the player's game state: phones, 2026-10-10, a DSM task committing mid-match
 * handed the screen the player's own creatures, so HP jumped back up and fainted creatures stood again.
 */
export function setInMatch(player: RpgPlayer, on: boolean) { if (on) inMatch.add(player); else inMatch.delete(player); }
/** A card the player taps through (the encounter card, Bramble's door), waiting for its tap. */
const taps = new WeakMap<RpgPlayer, () => void>();
/** The card a new fight waits on: every HUD refresh carries it, so it never goes missing while the battle waits for its tap. */
const cards = new WeakMap<RpgPlayer, { title: string; line: string }>();
/** NPC anchors match server.ts event positions and the camp layout in simplemap.tmx (fieldmap-v10). */
export const MIRA = { x: 272, y: 464 }, ROWAN = { x: 240, y: 240 };
/** Trainers: Kade by the meadow's west edge, Nessa on the far northeast shore. */
export const TRAINER_SPOTS: Record<string, { x: number; y: number }> = { kade: { x: 464, y: 240 }, nessa: { x: 720, y: 368 } };
/** The painted scarecrow in the camp garden. */
export const WAY_SIGN = { x: 432, y: 272 };
export const SCARECROW = { x: 112, y: 432 };
/** The painted notice board in the camp garden: the beta's weekly missions are read off it. */
export const BULLETIN_BOARD = { x: 256, y: 368 };
/** Bramble's door tile; stepping on it opens the trading post. */
const SHOP_DOOR = { tx: 18, ty: 4 };
/** Wild meadow bounds (tiles 14..19 × 6..10); the bottom row is plain lawn so the pond is reachable without an encounter. */
export const MEADOW = { x0: 448, x1: 640, y0: 192, y1: 352 };
/**
 * Where wild creatures are met: exactly the tiles that show tall grass, read from the map's
 * TallGrass layer (drawn by scripts/tall-grass.mjs): the meadow east of camp and Rowan's field in
 * the north-west. MEADOW above is the original meadow's box, kept for the sparkles and tests.
 */
const WILD_TILES: Set<string> = (() => {
  const tmx = readFileSync(join(process.cwd(), 'src/tiled/simplemap.tmx'), 'utf8');
  const m = tmx.match(/name="TallGrass"[^>]*>\s*<data encoding="csv">\n([\s\S]*?)<\/data>/);
  if (!m) throw new Error('simplemap.tmx has no TallGrass layer: the wild zones are gone');
  const tiles = new Set<string>();
  m[1].trim().split('\n').forEach((row, ty) => row.split(',').forEach((cell, tx) => { if (cell.trim() !== '' && Number(cell) !== 0) tiles.add(`${tx},${ty}`); }));
  return tiles;
})();
/** Whether a creature can be met at map position (x, y): it stands on tall grass. */
export const inTallGrass = (x: number, y: number): boolean => WILD_TILES.has(`${Math.floor(x / 32)},${Math.floor(y / 32)}`);
export const wildTileCount = (): number => WILD_TILES.size;
/** Pond water tiles (tx,ty); casting is allowed from any 4-neighbour of these. */
const POND = new Set(["17,12","18,12","19,12","20,12","21,12","17,13","18,13","19,13","20,13","21,13","22,13","16,14","17,14","18,14","19,14","20,14","21,14","22,14","16,15","17,15","18,15","19,15","20,15","21,15","22,15","16,16","17,16","18,16","19,16","20,16","21,16","22,16","17,17","18,17","19,17","20,17","21,17","17,18","18,18","19,18","20,18"]);
const T = 32;
/** Which way the water is from the player: the first neighbouring pond tile, or none. */
function pondSide(player: RpgPlayer): [number, number] | undefined {
  const tx = Math.floor(player.x() / T), ty = Math.floor(player.y() / T);
  return ([[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]).find(([dx, dy]) => POND.has(`${tx + dx},${ty + dy}`));
}
function nearPond(player: RpgPlayer): boolean {
  return pondSide(player) !== undefined;
}
function nearNpc(player: RpgPlayer): string | undefined {
  const spots: [string, { x: number; y: number }][] = [['Wayfinding sign', WAY_SIGN], ['Bulletin board', BULLETIN_BOARD], ['Scarecrow', SCARECROW], ['Mira', npcPosition(player, 'mira', MIRA)], ['Rowan', npcPosition(player, 'rowan', ROWAN)], ...Object.entries(TRAINER_SPOTS).map(([id, p]) => [TRAINERS[id].name, npcPosition(player, id, p)] as [string, { x: number; y: number }])];
  const near = spots.map(([name, p]) => [name, Math.hypot(player.x() - p.x, player.y() - p.y)] as const).filter(([, d]) => d <= 72).sort((a, b) => a[1] - b[1]);
  return near[0]?.[0];
}
const trainerByName = (name: string | undefined) => Object.keys(TRAINERS).find((id) => TRAINERS[id].name === name);
const atShopDoor = (player: RpgPlayer) => Math.floor(player.x() / T) === SHOP_DOOR.tx && Math.floor(player.y() / T) === SHOP_DOOR.ty;
function hudData(player: RpgPlayer, extra: Record<string, unknown> = {}) {
  const state = session(player).read();
  const who = nearNpc(player);
  const trainer = trainerByName(who);
  return {
    state, mode: 'field', nearPond: nearPond(player), nearNpc: who, atShop: atShopDoor(player),
    walletCoins: walletCoins(player),
    walletWaiting: walletWaiting(player),
    trainerBeaten: trainer ? state.trainersBeaten.includes(trainer) : false,
    encounter: cards.get(player) ?? null,
    ...extra,
  };
}
/** The one way a command changes the game state: the reducer, then what it means underneath. */
export function commit(player: RpgPlayer, command: Command, revision: number) {
  const local = session(player);
  const before = local.read();
  const next = local.execute(command, revision, `${before.holder}/command/${revision}`);
  player.creatureSave.set(local.snapshot());
  player.getGui('field-hud')?.update(hudData(player));
  onCommitted(player, command, before, next);
  return next;
}
// DSM tasks change the game state through the reducer, as every command does.
// One can land mid-battle (a proof of what the wallet owns, a delivered capture); the battle screen sends the
// revision it holds with every action, so it is handed the new one.
useCommit((player, command) => {
  const next = commit(player, command, session(player).read().revision);
  if (!inMatch.has(player)) player.getGui('creature-battle')?.update({ state: next, mode: 'battle', lastAction: 'sync', error: '' });
  return next;
});
useReadState((player) => session(player).read());
useHudData((player) => hudData(player));
export function fieldHud(player: RpgPlayer) {
  const hud = player.gui('field-hud');
  hud.on<{ action: string; creatureId?: string; creatureIds?: unknown[]; nick?: string; item?: string; look?: string; skin?: string | null }>('field', async ({ action, creatureId, creatureIds, nick, item, look, skin }) => {
    // The tap a card is waiting for: the battle (or the shop) opens behind it.
    if (!isCurrentAvatar(player)) return;
    if (action === 'fight') { taps.get(player)?.(); return; }
    if (fighting.has(player) || isSpeaking(player)) return;
    if (action === 'talk') {
      const who = nearNpc(player);
      if (who) web2(player, 'Talking', 'Dialogue runs on the game server: no DSM');
      const trainer = trainerByName(who);
      if (who === 'Wayfinding sign') await readWayfindingSign(player);
      else if (who === 'Bulletin board') await readBulletinBoard(player);
      else if (who === 'Scarecrow') await talkToScarecrow(player);
      else if (who === 'Rowan') await talkToRowan(player);
      else if (who === 'Mira') await restAtCamp(player);
      else if (trainer) await challengeTrainer(player, trainer);
      else if (nearPond(player)) await startBattle(player, 'cast');
      else hud.update(hudData(player, { notice: 'Walk to Mira at the rest camp to talk.' }));
      return;
    }
    if (action === 'cast') { if (nearPond(player)) await startBattle(player, 'cast'); return; }
    if (action === 'set-lead' && creatureId) { tryCommit(player, { type: 'set-lead', creatureId }); return; }
    if (action === 'set-team' && Array.isArray(creatureIds)) { tryCommit(player, { type: 'set-team', creatureIds: creatureIds.filter((x): x is string => typeof x === 'string') }); return; }
    if (action === 'rename' && creatureId) { tryCommit(player, { type: 'rename', creatureId, nick: nick ?? '' }); return; }
    if (action === 'wear-skin' && (skin === null || (SKINS as readonly string[]).includes(skin ?? ''))) {
      tryCommit(player, { type: 'wear-skin', skin: skin as Skin | null });
      player.setGraphic(graphicOf(player));
      return;
    }
    if (action === 'set-look' && (LOOKS as readonly string[]).includes(look ?? '')) {
      tryCommit(player, { type: 'set-look', look: look as Look });
      player.setGraphic(graphicOf(player));
      return;
    }
    if (action === 'report-missions') { hud.update(hudData(player, { reportList: await gameReportList() })); return; }
    if (action === 'lobby') { await openLobby(player); return; }
    if (action === 'shop' || action === 'enter-shop') {
      hud.update(hudData(player));
      try { await openShop(player); }
      catch (e) { hud.update(hudData(player, { notice: `Trading post: ${e instanceof Error ? e.message : String(e)}` })); }
      fieldHud(player);
      return;
    }
    if (action === 'use-item' && item && creatureId) { tryCommit(player, { type: 'use-item', item: item as 'poultice' | 'tonic', creatureId }); return; }
    if (action === 'challenge' && trainerByName(nearNpc(player))) { await challengeTrainer(player, trainerByName(nearNpc(player))!); return; }
    if (action === 'market') {
      try { await openMarket(player); }
      catch (e) { hud.update(hudData(player, { notice: `Market: ${e instanceof Error ? e.message : String(e)}` })); }
      fieldHud(player);
      return;
    }
  });
  void hud.open(hudData(player));
  // A battle a reconnect left open picks up where it stopped: the field has no controls while one is active.
  if (session(player).read().battle?.outcome === 'active') {
    startBattle(player, 'encounter').catch((e) => hud.update(hudData(player, { notice: `Battle: ${e instanceof Error ? e.message : String(e)}` })));
  }
}
function tryCommit(player: RpgPlayer, command: Command) {
  try { commit(player, command, session(player).read().revision); }
  catch (error) {
    if (!(error instanceof GameError)) throw error;
    player.getGui('field-hud')?.update(hudData(player, { notice: player.t(`game.error.${error.code}`) }));
  }
}
export async function checkEncounter(player: RpgPlayer) {
  // The game starts once the wallet is connected.
  if (!player.creatureSave()) return;
  walked(player);
  const close = `${nearNpc(player) ?? ''}/${nearPond(player)}/${atShopDoor(player)}`;
  if (proximity.get(player) !== close) {
    proximity.set(player, close);
    player.getGui('field-hud')?.update(hudData(player, { door: atShopDoor(player) }));
  }
  const x = player.x(), y = player.y();
  const inWild = inTallGrass(x, y);
  if (!inWild) { inside.delete(player); return; }
  if (inside.has(player) || fighting.has(player) || inArena.has(player)) return;
  inside.add(player);
  await startBattle(player, 'encounter');
}
export async function talkToScarecrow(player: RpgPlayer) {
  if (fighting.has(player) || isSpeaking(player)) return;
  const remaining = await claimScarecrowGift(player);
  const minutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(minutes / 60), mins = minutes % 60;
  const wait = [hours ? `${hours}h` : '', mins ? `${mins}m` : ''].filter(Boolean).join(' ');
  await portraitDialogue(player, [{ speaker: 'Scarecrow', portrait: null, message: remaining
    ? `Easy there, catcher! I’m still stuffing more capsules into my pockets. Come back in ${wait}.`
    : `Psst! Take these ${SCARECROW_CAPSULES} capture capsules—on the house. Go catch something good. I’ll have more for you in four hours!` }]);
}
async function challengeTrainer(player: RpgPlayer, trainer: string) {
  const release = pauseNpc(player, trainer);
  try { await runTrainerChallenge(player, trainer); }
  finally { release(); }
}
async function runTrainerChallenge(player: RpgPlayer, trainer: string) {
  const t = TRAINERS[trainer];
  const portrait = trainer as 'kade' | 'nessa';
  const who = `${t.name} · ${t.title}`;
  const state = session(player).read();
  if (state.trainersBeaten.includes(trainer)) { await portraitDialogue(player, [{ speaker: who, portrait, message: t.beaten }]); return; }
  if (state.creatures[state.lead].hp === 0) { await portraitDialogue(player, [{ speaker: who, portrait, message: 'Your lead can barely stand. See Mira first, then we’ll talk.' }]); return; }
  web2(player, 'Trainer', `${t.name} challenges you: the battle runs on the game server`);
  await portraitDialogue(player, t.greeting.map((message) => ({ speaker: who, portrait, message })));
  await startBattle(player, 'challenge', trainer);
  const outcome = session(player).read().battle?.outcome;
  if (outcome === 'victory') await portraitDialogue(player, [{ speaker: who, portrait, message: t.win }]);
  else if (outcome === 'defeat') await portraitDialogue(player, [{ speaker: who, portrait, message: t.lose }]);
}
async function startBattle(player: RpgPlayer, kind: 'encounter' | 'cast' | 'challenge', trainer?: string) {
  if (fighting.has(player)) return;
  const state = session(player).read();
  const lead = state.creatures[state.lead];
  if (!lead.hp) {
    player.getGui('field-hud')?.update(hudData(player, { notice: `${displayName(lead)} needs rest. Swap leads in the BAG or talk to Mira.` }));
    return;
  }
  fighting.add(player);
  player.breakRoutes(true);
  try {
    // A cast: the rod goes out and the bobber floats, then a bite pulls the line taut.
    if (kind === 'cast') {
      // Face the water, and tell the screen which way the line goes.
      const [dx, dy] = pondSide(player) ?? [0, 1];
      player.changeDirection((dx > 0 ? 'right' : dx < 0 ? 'left' : dy < 0 ? 'up' : 'down') as Parameters<RpgPlayer['changeDirection']>[0]);
      player.getGui('field-hud')?.update(hudData(player, { notice: 'Cast… waiting for a bite.', fishing: { phase: 'cast', dx, dy } }));
      await new Promise(r => setTimeout(r, 1800));
      player.getGui('field-hud')?.update(hudData(player, { notice: 'Something bit!', fishing: { phase: 'bite', dx, dy } }));
      await new Promise(r => setTimeout(r, 900));
    }
    const command: Command = kind === 'challenge' ? { type: 'challenge', trainer: trainer! } : { type: kind };
    const resumed = state.battle?.outcome === 'active';
    let next;
    try { next = resumed ? state : commit(player, command, state.revision); }
    catch (error) {
      if (!(error instanceof GameError)) throw error;
      player.getGui('field-hud')?.update(hudData(player, { notice: player.t(`game.error.${error.code}`) }));
      return;
    }
    // A new fight announces itself and opens on the player's tap, as the design's Field page does.
    if (!resumed) {
      await new Promise(r => setTimeout(r, 250));
      const card = kind === 'challenge'
        ? { title: 'TRAINER BATTLE', line: `${TRAINERS[trainer!].name} wants to battle!` }
        : { title: 'WILD ENCOUNTER', line: 'A wild creature appeared!' };
      await new Promise<void>((tapped) => {
        taps.set(player, tapped);
        cards.set(player, card);
        player.getGui('field-hud')?.update(hudData(player));
      });
      taps.delete(player);
      cards.delete(player);
    }
    const gui = player.gui('creature-battle');
    gui.on<{ action: string; revision: number; nick?: string; creatureId?: string }>('battle', ({ action, revision, nick, creatureId }) => {
      if (action === 'continue') {
        if (session(player).read().battle?.outcome !== 'active') gui.close();
        return;
      }
      const current = session(player).read();
      const combatant = current.creatures.find(c => c.id === current.battle?.creatureId) ?? current.creatures[current.lead];
      const isMove = SPECIES[combatant.species].moves.some(m => m.id === action);
      const [kind, item, ...target] = action.split(':');
      const command: Command | undefined = isMove ? { type: 'move', move: action }
        // An item spends the turn: `item:<poultice|tonic>:<creature id>`.
        : kind === 'item' && (item === 'poultice' || item === 'tonic') && target.length ? { type: 'battle-item', item, creatureId: target.join(':') }
        : action === 'capture' ? { type: 'capture', nick } : action === 'escape' ? { type: 'escape' }
        // A creature is named after it is caught, while the battle screen is still open.
        : action === 'rename' && creatureId ? { type: 'rename', creatureId, nick: nick ?? '' } : undefined;
      if (!command) return;
      try { gui.update({ state: commit(player, command, revision), mode: 'battle', lastAction: action, error: '' }); }
      catch (error) {
        if (!(error instanceof GameError)) throw error;
        gui.update({ state: session(player).read(), mode: 'battle', error: player.t(`game.error.${error.code}`) });
      }
    });
    await gui.open({ state: next, mode: 'battle', lastAction: '', error: '' }, { waitingAction: true, blockPlayerInput: true });
  } finally { fighting.delete(player); player.getGui('field-hud')?.update(hudData(player)); }
}
export async function restAtCamp(player: RpgPlayer) {
  if (fighting.has(player) || isSpeaking(player)) return;
  commit(player, { type: 'heal' }, session(player).read().revision);
  await portraitDialogue(player, [
    { speaker: 'Mira · Camp Healer', portrait: 'mira', message: 'There you are! Your creatures have rested by the campfire. Their HP and special moves are full again.' },
    { speaker: 'You', portrait: 'player', message: 'Thanks, Mira. We’re ready to explore the meadow again.' },
    { speaker: 'Mira · Camp Healer', portrait: 'mira', message: 'Take care out there. A new companion keeps the HP it had when you caught it, so bring it to me for a rest too.' },
  ]);
}
