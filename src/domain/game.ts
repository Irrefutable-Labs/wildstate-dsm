import { z } from 'zod';
import { exchange, type Action } from './duel';

export type Element = 'fire' | 'grass' | 'water' | 'electric' | 'none';
export type StatusId = 'burn' | 'root' | 'stun' | 'soaked';
/** fx is presentation metadata only; the reducer never reads it. */
export type MoveFx = 'proj' | 'bite' | 'tongue' | 'snare' | 'bash' | 'jet' | 'tusk' | 'camo' | 'chain' | 'lure';
export type MoveDef = { id: string; name: string; el: Element; dmg?: number; max: number; status?: StatusId; guard?: true; heal?: number; fx?: MoveFx };
type SpeciesDef = { name: string; el: Element; moves: MoveDef[] };

/** Pinned content. Clients send move ids only; the reducer resolves every number here. */
export const ELEMENTS: Record<Element, { beats: Element[] }> = {
  fire: { beats: ['grass'] }, grass: { beats: ['water', 'electric'] }, water: { beats: ['fire'] }, electric: { beats: ['water'] }, none: { beats: [] },
};
export const STATUSES: Record<StatusId, { turns: number }> = { burn: { turns: 2 }, root: { turns: 1 }, stun: { turns: 1 }, soaked: { turns: 2 } };
export const SPECIES: Record<string, SpeciesDef> = {
  embercub: { name: 'Embercub', el: 'fire', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'flare', name: 'Flare', el: 'fire', dmg: 14, max: 5 },
    { id: 'ember-bite', name: 'Ember Bite', el: 'fire', dmg: 9, max: 3, status: 'burn', fx: 'bite' },
    { id: 'warm-coat', name: 'Warm Coat', el: 'none', guard: true, max: 2 },
  ] },
  mossling: { name: 'Mossling', el: 'grass', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'leaf-cut', name: 'Leaf Cut', el: 'grass', dmg: 12, max: 5 },
    { id: 'root-bind', name: 'Root Bind', el: 'grass', dmg: 6, max: 3, status: 'root', fx: 'snare' },
    { id: 'photosynth', name: 'Photosynth', el: 'none', heal: 12, max: 1 },
  ] },
  tidefin: { name: 'Tidefin', el: 'water', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'tide-lash', name: 'Tide Lash', el: 'water', dmg: 12, max: 5, fx: 'jet' },
    { id: 'soak', name: 'Soak', el: 'water', dmg: 7, max: 3, status: 'soaked', fx: 'jet' },
    { id: 'mist-veil', name: 'Mist Veil', el: 'none', guard: true, max: 2 },
  ] },
  voltusk: { name: 'Voltusk', el: 'electric', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'volt-charge', name: 'Volt Charge', el: 'electric', dmg: 12, max: 5, fx: 'tusk' },
    { id: 'static-tusk', name: 'Static Tusk', el: 'electric', dmg: 7, max: 3, status: 'stun', fx: 'tusk' },
    { id: 'bristle', name: 'Bristle', el: 'none', guard: true, max: 2 },
  ] },
  leon: { name: 'Leon', el: 'grass', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'tongue-lash', name: 'Tongue Lash', el: 'grass', dmg: 12, max: 5, fx: 'tongue' },
    { id: 'sticky-snare', name: 'Sticky Snare', el: 'grass', dmg: 6, max: 3, status: 'root', fx: 'snare' },
    { id: 'camouflage', name: 'Camouflage', el: 'none', guard: true, max: 2, fx: 'camo' },
  ] },
  rattlefin: { name: 'Rattlefin', el: 'water', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'chain-whip', name: 'Chain Whip', el: 'water', dmg: 12, max: 5, fx: 'chain' },
    { id: 'lure-flash', name: 'Lure Flash', el: 'water', dmg: 6, max: 3, status: 'stun', fx: 'lure' },
    { id: 'rust-hide', name: 'Rust Hide', el: 'none', guard: true, max: 2 },
  ] },
  brineback: { name: 'Brineback', el: 'water', moves: [
    { id: 'strike', name: 'Strike', el: 'none', dmg: 8, max: 0 },
    { id: 'brine-jet', name: 'Brine Jet', el: 'water', dmg: 12, max: 5, fx: 'jet' },
    { id: 'barnacle-bash', name: 'Barnacle Bash', el: 'water', dmg: 7, max: 3, status: 'soaked', fx: 'bash' },
    { id: 'shell-up', name: 'Shell Up', el: 'none', guard: true, max: 2 },
  ] },
};
/** Growth: flat 20 XP per level, cap 10. Every number here is pinned content; clients never send stats. */
export const XP_PER_LEVEL = 20, LEVEL_CAP = 10, BASE_HP = 40, HP_PER_LEVEL = 4;
/** Absolute HP ceiling for schema validation (level cap). */
const MAX_HP = BASE_HP + HP_PER_LEVEL * (LEVEL_CAP - 1);
export const level = (c: { xp: number }): number => Math.min(LEVEL_CAP, 1 + Math.floor(c.xp / XP_PER_LEVEL));
export const maxHp = (c: { xp: number }): number => BASE_HP + HP_PER_LEVEL * (level(c) - 1);
export const damageBonus = (c: { xp: number }): number => level(c) - 1;
export const chargeBonus = (c: { xp: number }): number => (level(c) >= 4 ? 1 : 0) + (level(c) >= 7 ? 1 : 0);
export const maxCharges = (m: MoveDef, c: { xp: number }): number => (m.max ? m.max + chargeBonus(c) : 0);
/** Base XP × opponent-level scaling: +2 per level the opponent has over you, -2 per level under, floor 4. */
export const xpGain = (base: number, opponentLevel: number, ownLevel: number): number => Math.max(4, base + 2 * (opponentLevel - ownLevel));
/** Wild level rises with the holder's encounter count (cap 6) but never more than one above the lead. */
export const wildLevel = (encounterIndex: number, leadLevel = 1): number => Math.max(1, Math.min(6, 1 + Math.floor(encounterIndex / 3), leadLevel + 1));
export const TRAINER_LEVEL: Record<string, number> = { kade: 3, nessa: 4 };
/** Item effects are pinned here; the client only names the item. */
export const ITEMS = { poultice: { heal: 15 }, tonic: { charges: true } } as const;
export type UsableItem = keyof typeof ITEMS;
/**
 * Trainers who wait on the map. They field a team of three at full strength (no wild handicap),
 * one at a time; knocking out all three wins, and pays a bounty from the game account. A trainer can be
 * challenged again after the party rests at camp.
 */
type TrainerDef = { name: string; title: string; team: { species: keyof typeof SPECIES; nick: string }[]; greeting: string[]; win: string; lose: string; beaten: string };
/** Team battles: each side fields up to three, one at a time; whoever knocks out all of the other side's wins. */
export const TEAM_SIZE = 3;
export const TRAINERS: Record<string, TrainerDef> = {
  kade: { name: 'Kade', title: 'Meadow Drifter', team: [{ species: 'mossling', nick: 'Burr' }, { species: 'voltusk', nick: 'Static' }, { species: 'leon', nick: 'Lash' }], greeting: ['Hey, trainer. Burr and I take on anyone who crosses this meadow.', 'Twelve WILD says you can’t knock him down. Paid straight to your wallet if you do.'], win: 'Ha! Burr hasn’t hit the grass in weeks. The bounty’s yours, fair and square.', lose: 'That’s how it goes. Rest up with Mira and come find me again.', beaten: 'You already took my WILD today. Rest at camp and I’ll go another round.' },
  nessa: { name: 'Nessa', title: 'Pond Keeper', team: [{ species: 'tidefin', nick: 'Ripple' }, { species: 'brineback', nick: 'Barnacle' }, { species: 'rattlefin', nick: 'Lantern' }], greeting: ['Careful by the water. Ripple doesn’t like strangers near her pond.', 'One bout. Beat her and the bounty is yours; lose and you walk back to camp.'], win: 'Ripple! …Fine. You earned that bounty. Well fought.', lose: 'The pond stays ours. Come back when your creature has rested.', beaten: 'Ripple needs to rest after your last bout. So do you, by the look of it. Come back after camp.' },
};
/** Meadow grass rotation; water species only come from the pond. */
const WILD_ORDER = ['mossling', 'voltusk', 'leon', 'embercub'] as const;
const POND_ORDER = ['tidefin', 'brineback', 'rattlefin'] as const;
export const NICK_MAX = 12;

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const speciesSchema = z.enum(['embercub', 'mossling', 'tidefin', 'voltusk', 'leon', 'rattlefin', 'brineback']);
const statusSchema = z.object({ id: z.enum(['burn', 'root', 'stun', 'soaked']), turns: natural.max(5) });
const creatureSchema = z.object({
  id: z.string().min(1), species: speciesSchema, nick: z.string().max(NICK_MAX), hp: natural.max(MAX_HP), xp: natural,
  charges: z.record(z.string(), natural.max(7)), guard: z.boolean(), statuses: z.array(statusSchema).max(4),
  /** DSM ledger: the anchor (Base32) of the object that is this creature, once the game issued it. */
  anchor: z.string().min(1).nullable(),
});
const battleSchema = z.object({
  id: z.string(), creatureId: z.string(), wild: creatureSchema, turn: natural, source: z.enum(['meadow', 'pond', 'trainer']),
  /** For a trainer battle: who stands on the other side. */
  trainer: z.string().optional(),
  outcome: z.enum(['active', 'victory', 'defeat', 'captured', 'escaped']),
  /** Projection log of the last accepted turn so the UI can animate without recomputing rules. */
  log: z.array(z.object({ actor: z.enum(['own', 'wild']), move: z.string(), dmg: natural, mult: z.number(), status: z.string().optional(), burn: natural, skipped: z.boolean() })).max(2),
  /** XP granted by the finishing command and the levels crossed, so the UI can show the level-up without recomputing. */
  growth: z.object({ gain: natural, from: natural, to: natural }).optional(),
  /** `team3`: each side fields up to three, one at a time; a wild encounter is `single`. */
  format: z.enum(['single', 'team3']).default('single'),
  /** Team battles: the player's fielded creature ids, in order; `creatureId` is the active one. */
  roster: z.array(z.string()).max(TEAM_SIZE).default([]),
  /** Team battles: the opponent's creatures still waiting; `wild` is the active one. */
  bench: z.array(creatureSchema).max(TEAM_SIZE).default([]),
  /** Knockouts so far: `own` the player's creatures, `foe` the opponent's. */
  ko: z.object({ own: natural, foe: natural }).default({ own: 0, foe: 0 }),
  /** What else happened in the last turn, for the UI: a creature fainted, or one was sent in. */
  events: z.array(z.object({ side: z.enum(['own', 'foe']), kind: z.enum(['faint', 'switch']), creature: z.string() })).max(4).default([]),
});
/** How the player's trainer looks on the map, in battle and in dialogue: a game choice, no DSM. */
export const LOOKS = ['classic', 'auburn', 'bearded', 'curly'] as const;
export type Look = (typeof LOOKS)[number];
/**
 * Skins Bramble sells (the Halloween set): worn over the trainer's look, on the map. Game items,
 * bought with WILD from the wallet and granted on the payment the game's account accepted.
 */
export const SKINS = ['pumpkin', 'reaper', 'witch', 'vampire', 'werewolf', 'mummy', 'ghost', 'frankenstein', 'demon_girl'] as const;
export type Skin = (typeof SKINS)[number];
export const SKIN_NAMES: Record<Skin, string> = {
  pumpkin: 'Pumpkin', reaper: 'Reaper', witch: 'Witch', vampire: 'Vampire', werewolf: 'Werewolf',
  mummy: 'Mummy', ghost: 'Ghost', frankenstein: 'Frankenstein', demon_girl: 'Demon Girl',
};
/** The map sprite of a skin (src/config/config.client.ts) and its picture (public/skins). */
export const skinGraphic = (skin: Skin) => `skin-${skin}`;
export const skinPicture = (skin: Skin) => `skins/${skin}.png`;
/** The map sprite and the portrait of a look. */
export const lookGraphic = (look: Look) => (look === 'classic' ? 'hero' : `hero-${look}`);
export const lookPortrait = (look: Look) => (look === 'classic' ? 'player' : `player-${look}`);
export const stateSchema = z.object({
  scarecrowReadyAt: natural.default(0),
  rules: z.literal('creatures-v4'), holder: z.string().min(1), revision: natural,
  // Coins and creatures are owned in the player's DSM wallet: `coins` is a projection of what
  // the wallet proved it owns, and the reducer never credits or debits it.
  nextEncounter: natural, nextCast: natural, creatures: z.array(creatureSchema).min(1), lead: natural,
  inventory: z.object({ capsules: natural, rod: z.boolean(), poultice: natural, tonic: natural, map: natural }), coins: natural,
  campaign: z.object({ instance: z.string(), branch: z.enum(['unselected', 'sanctuary', 'rangers']) }),
  battle: battleSchema.nullable(), consumed: z.array(z.string()), commandIds: z.array(z.string()),
  victories: natural, captures: natural,
  /** Trainers beaten since the last rest at camp; a rest reopens every challenge. */
  trainersBeaten: z.array(z.string()).default([]),
  /** The player's chosen team for team battles, in order (creature ids); empty means lead first. */
  team: z.array(z.string()).max(TEAM_SIZE).default([]),
  /** The trainer's look, picked once when the game first opens; it does not change after. */
  look: z.enum(LOOKS).default('classic'),
  lookPicked: z.boolean().default(false),
  /** Skins bought from Bramble, and the one worn on the map (none: the look shows). */
  skins: z.array(z.enum(SKINS)).default([]),
  skin: z.enum(SKINS).nullable().default(null),
}).superRefine((s, ctx) => {
  const ids = s.creatures.map(c => c.id);
  if (new Set(ids).size !== ids.length || new Set(s.consumed).size !== s.consumed.length ||
      new Set(s.commandIds).size !== s.commandIds.length || (s.battle && !ids.includes(s.battle.creatureId)) || s.lead >= s.creatures.length ||
      new Set(s.team).size !== s.team.length || new Set(s.skins).size !== s.skins.length || (s.skin !== null && !s.skins.includes(s.skin)) || (s.battle?.outcome === 'active' && s.battle.roster.some(id => !ids.includes(id)))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid state references' });
  }
});
export type GameState = z.infer<typeof stateSchema>;
export type Creature = GameState['creatures'][number];
export type Command =
  | { type: 'encounter' } | { type: 'cast' } | { type: 'move'; move: string } | { type: 'capture'; nick?: string } | { type: 'escape' }
  | { type: 'heal' } | { type: 'campaign'; branch: 'sanctuary' | 'rangers' }
  | { type: 'set-lead'; creatureId: string } | { type: 'rename'; creatureId: string; nick: string }
  /** Choose up to three creatures, in order, for team battles. */
  | { type: 'set-team'; creatureIds: string[] }
  /** Pick how the trainer looks: once, the first time the game opens. */
  | { type: 'set-look'; look: Look }
  /** Spend this battle turn on a bag item for one of the fielded creatures; the opponent still acts. */
  | { type: 'battle-item'; item: UsableItem; creatureId: string }
  /** A bag item spent in a player-vs-player match (the match applies its effect to its own snapshot). */
  | { type: 'consume-item'; item: UsableItem }
  /** DSM ledger: a capsule for a payment the game's account accepted (`fact` is that transfer's id). */
  | { type: 'grant-capsule'; fact: string }
  /** Server-timed game item gift; never a DSM coin issuance. */
  | { type: 'scarecrow-gift'; now: number }
  /** DSM ledger: `qty` items Bramble sold for one payment the game's account accepted. */
  | { type: 'grant-item'; item: ShopItemId; fact: string; qty?: number }
  /** DSM ledger: a skin Bramble sold for one payment the game's account accepted (`fact` is that transfer's id). */
  | { type: 'grant-skin'; skin: Skin; fact: string }
  /** Wear an owned skin on the map, or none (`null`) to show the trainer's look again. */
  | { type: 'wear-skin'; skin: Skin | null }
  /** DSM ledger: a creature Bramble bought; `fact` is the transfer of its object the game's account accepted. */
  | { type: 'sell'; creatureId: string; fact: string }
  /** Use a bag item on one party creature, outside battle. */
  | { type: 'use-item'; item: UsableItem; creatureId: string }
  /** Challenge a trainer on the map. */
  | { type: 'challenge'; trainer: string }
  /** DSM ledger: creature `creatureId` is the object `anchor`. */
  | { type: 'bind-creature'; creatureId: string; anchor: string }
  /**
   * DSM ledger: what the wallet owns, verified. `coins` is the WILD it owns; `held` the creature
   * anchors it owns; `inFlight` the anchors the game sent this wallet that no proof shows yet.
   */
  | { type: 'holdings'; coins: number; held: string[]; inFlight: string[] }
  /** DSM ledger: a creature the wallet holds that this state does not: it joins the party. */
  | { type: 'receive-creature'; creature: Creature };
type ErrorCode = 'stale' | 'battle-active' | 'no-battle' | 'fainted' | 'no-charges' |
  'no-capsules' | 'not-weakened' | 'choice-consumed' | 'invalid-command' | 'look-picked' | 'no-rod' | 'unknown-creature' |
  'no-item' | 'not-wild' | 'already-beaten' | 'unknown-trainer' | 'sold-out' | 'not-for-sale' | 'gift-cooldown' | 'unavailable' | 'skin-owned' | 'skin-not-owned';
/** What Bramble's board sells. The Map is a key item: one per player. */
const SHOP_ITEM_IDS = ['capsule', 'poultice', 'tonic', 'map'] as const;
export type ShopItemId = typeof SHOP_ITEM_IDS[number];
export const SHOP_QTY_MAX = 9;
export const SCARECROW_CAPSULES = 3;
export const SCARECROW_COOLDOWN_MS = 4 * 60 * 60 * 1000;
/** What Bramble pays for a creature, in WILD: more for a stronger one. */
export const salePrice = (c: { xp: number }): number => 6 + 2 * level(c);
export class GameError extends Error { constructor(public readonly code: ErrorCode) { super(code); } }

export function newCreature(id: string, species: keyof typeof SPECIES, hp?: number, lvl = 1): Creature {
  const xp = (Math.min(LEVEL_CAP, Math.max(1, lvl)) - 1) * XP_PER_LEVEL;
  const stub = { xp };
  return { id, species: species as Creature['species'], nick: '', hp: Math.min(maxHp(stub), hp ?? maxHp(stub)), xp, guard: false, statuses: [], anchor: null,
    charges: Object.fromEntries(SPECIES[species].moves.filter(m => m.max).map(m => [m.id, maxCharges(m, stub)])) };
}
/** Adds XP and applies growth once per crossed level: +HP_PER_LEVEL current HP, +1 charge on moves that gained a slot. Returns the levels crossed. */
export function grantXp(c: Creature, amount: number): { gain: number; from: number; to: number } {
  const from = level(c); c.xp += amount; const to = level(c);
  if (to > from) {
    c.hp = Math.min(maxHp(c), c.hp + HP_PER_LEVEL * (to - from));
    const before = { xp: (from - 1) * XP_PER_LEVEL };
    for (const m of SPECIES[c.species].moves) if (m.max && maxCharges(m, c) > maxCharges(m, before)) c.charges[m.id] = (c.charges[m.id] ?? 0) + (maxCharges(m, c) - maxCharges(m, before));
  }
  return { gain: amount, from, to };
}
export function initialState(holder: string): GameState {
  return stateSchema.parse({
    rules: 'creatures-v4', holder, revision: 0, nextEncounter: 0, nextCast: 0, lead: 0,
    creatures: [newCreature(`${holder}/starter`, 'embercub')], inventory: { capsules: 3, rod: true, poultice: 1, tonic: 0, map: 0 }, coins: 0,
    campaign: { instance: `${holder}/campaign/1`, branch: 'unselected' },
    battle: null, consumed: [], commandIds: [], victories: 0, captures: 0, trainersBeaten: [],
  });
}
export function score(s: GameState): number { return s.victories * 10 + s.captures * 20; }
export function displayName(c: Creature): string { return c.nick || SPECIES[c.species].name; }
const cleanNick = (n: string | undefined) => (n ?? '').trim().slice(0, NICK_MAX);
export function multiplier(attack: Element, defender: Element): number {
  return ELEMENTS[attack].beats.includes(defender) ? 1.5 : ELEMENTS[defender].beats.includes(attack) ? 0.5 : 1;
}
function fail(code: ErrorCode): never { throw new GameError(code); }

/** A bag item's effect: a poultice heals, a tonic refills every charge. */
export function applyItem(c: Creature, item: UsableItem) {
  if (item === 'poultice') c.hp = Math.min(maxHp(c), c.hp + ITEMS.poultice.heal);
  else c.charges = newCreature(c.id, c.species, undefined, level(c)).charges;
}
function clearBattleOnly(c: Creature) { c.guard = false; c.statuses = []; }
/** Wild creatures spawn at a level with 70% of that level's max HP (the old 28/40). */
function wildAt(id: string, species: keyof typeof SPECIES, lvl: number): Creature { const c = newCreature(id, species, undefined, lvl); c.hp = Math.round(maxHp(c) * 0.7); return c; }

/** The creatures a player fields in a team battle: their chosen team, else the lead and then the rest, standing ones only. */
export function fieldedTeam(s: GameState): string[] {
  const standing = (id: string) => (s.creatures.find(c => c.id === id)?.hp ?? 0) > 0;
  const lead = s.creatures[s.lead].id;
  const order = [...s.team, lead, ...s.creatures.map(c => c.id)];
  return [...new Set(order)].filter(standing).slice(0, TEAM_SIZE);
}

/** The game's own reduction of play (battles, captures, progress); never a DSM transition. */
export function transition(parent: GameState, expected: number, commandId: string, command: Command): GameState {
  if (parent.revision !== expected || parent.commandIds.includes(commandId)) fail('stale');
  if (!commandId.trim()) fail('invalid-command');
  const s = structuredClone(stateSchema.parse(parent));
  const active = s.battle?.outcome === 'active';
  if (['encounter', 'cast', 'challenge', 'heal', 'campaign', 'set-lead', 'set-team', 'use-item', 'scarecrow-gift', 'wear-skin'].includes(command.type) && active) fail('battle-active');
  const lead = s.creatures[s.lead];
  const battle = s.battle;
  const combatant = battle ? s.creatures.find(c => c.id === battle.creatureId)! : lead;
  const finish = (outcome: NonNullable<GameState['battle']>['outcome']) => {
    battle!.outcome = outcome;
    const key = `encounter/${battle!.id}`;
    if (s.consumed.includes(key)) fail('stale');
    s.consumed.push(key);
    clearBattleOnly(combatant); clearBattleOnly(battle!.wild);
    for (const id of battle!.roster) { const c = s.creatures.find(x => x.id === id); if (c) clearBattleOnly(c); }
  };
  // The game's account pays the reward as a transfer to the wallet; this state never credits it.
  const win = () => {
    finish('victory'); s.victories += 1;
    const base = battle!.source === 'trainer' ? 15 : 10;
    battle!.growth = grantXp(combatant, xpGain(base, level(battle!.wild), level(combatant)));
    if (battle!.source === 'trainer') s.trainersBeaten.push(battle!.trainer!);
  };
  switch (command.type) {
    case 'encounter': {
      if (lead.hp === 0) fail('fainted');
      const n = s.nextEncounter++;
      const id = `${s.holder}/wild/${n}`;
      // A fixed rotation: the game's own design, not protocol entropy.
      s.battle = { id, creatureId: lead.id, turn: 0, outcome: 'active', source: 'meadow', log: [], wild: wildAt(`${id}/creature`, WILD_ORDER[n % WILD_ORDER.length], wildLevel(n, level(lead))),
        format: 'single', roster: [lead.id], bench: [], ko: { own: 0, foe: 0 }, events: [] };
      break;
    }
    case 'cast': {
      if (!s.inventory.rod) fail('no-rod');
      if (lead.hp === 0) fail('fainted');
      const n = s.nextCast++;
      const id = `${s.holder}/pond/${n}`;
      s.battle = { id, creatureId: lead.id, turn: 0, outcome: 'active', source: 'pond', log: [], wild: wildAt(`${id}/creature`, POND_ORDER[n % POND_ORDER.length], wildLevel(n, level(lead))),
        format: 'single', roster: [lead.id], bench: [], ko: { own: 0, foe: 0 }, events: [] };
      break;
    }
    case 'challenge': {
      const t = TRAINERS[command.trainer];
      if (!t) fail('unknown-trainer');
      // A team battle needs one creature standing, not necessarily the lead.
      const roster = fieldedTeam(s);
      if (roster.length === 0) fail('fainted');
      if (s.trainersBeaten.includes(command.trainer)) fail('already-beaten');
      const id = `${s.holder}/trainer/${command.trainer}/${s.consumed.filter(k => k.startsWith(`encounter/${s.holder}/trainer/${command.trainer}/`)).length}`;
      const lvl = TRAINER_LEVEL[command.trainer] ?? 3;
      const [foe, ...bench] = t.team.map((m, i) => { const c = newCreature(`${id}/creature/${i}`, m.species, undefined, lvl); c.nick = m.nick; return c; });
      s.battle = { id, creatureId: roster[0], turn: 0, outcome: 'active', source: 'trainer', trainer: command.trainer, log: [], wild: foe,
        format: 'team3', roster, bench, ko: { own: 0, foe: 0 }, events: [] };
      break;
    }
    case 'use-item': {
      const c = s.creatures.find(c => c.id === command.creatureId);
      if (!c) fail('unknown-creature');
      if (!(command.item in ITEMS) || s.inventory[command.item] === 0) fail('no-item');
      s.inventory[command.item] -= 1;
      applyItem(c!, command.item);
      break;
    }
    case 'set-team': {
      const ids = command.creatureIds;
      if (!Array.isArray(ids) || ids.length > TEAM_SIZE || new Set(ids).size !== ids.length || ids.some(id => !s.creatures.some(c => c.id === id))) fail('invalid-command');
      s.team = [...ids]; break;
    }
    case 'set-look': {
      if (s.lookPicked) fail('look-picked');
      if (!LOOKS.includes(command.look)) fail('invalid-command');
      s.look = command.look; s.lookPicked = true; break;
    }
    case 'set-lead': {
      const i = s.creatures.findIndex(c => c.id === command.creatureId);
      if (i < 0) fail('unknown-creature');
      s.lead = i; break;
    }
    case 'rename': {
      const c = s.creatures.find(c => c.id === command.creatureId);
      if (!c) fail('unknown-creature');
      c.nick = cleanNick(command.nick); break;
    }
    case 'consume-item': {
      if (!(command.item in ITEMS) || s.inventory[command.item] === 0) fail('no-item');
      s.inventory[command.item] -= 1; break;
    }
    case 'battle-item':
    case 'move': {
      if (!active) fail('no-battle');
      if (combatant.hp === 0) fail('fainted');
      let own: Action;
      if (command.type === 'battle-item') {
        // The item goes to a fielded creature still standing; the creature in front then does nothing else this turn.
        const target = battle!.roster.includes(command.creatureId) ? s.creatures.find(c => c.id === command.creatureId) : undefined;
        if (!target || target.hp === 0) fail('unknown-creature');
        if (!(command.item in ITEMS) || s.inventory[command.item] === 0) fail('no-item');
        s.inventory[command.item] -= 1;
        applyItem(target!, command.item);
        own = { item: command.item };
      } else {
        const move = SPECIES[combatant.species].moves.find(m => m.id === command.move);
        if (!move) fail('invalid-command');
        if (move.max && (combatant.charges[move.id] ?? 0) === 0) fail('no-charges');
        own = move;
      }
      const wild = battle!.wild;
      battle!.events = [];
      // Opponent action: a wild creature always uses its signature move (index 1), weakened for
      // balance; a trainer's creature alternates signature and status moves at full strength.
      const trainer = battle!.source === 'trainer';
      const wm = SPECIES[wild.species].moves[trainer && (battle!.turn + 1) % 2 === 1 ? 2 : 1];
      const [mine, theirs] = exchange(combatant, own, wild, wm, { weaken: trainer ? 0 : 4, landsStatus: trainer, spendsCharge: false });
      battle!.turn += 1;
      battle!.log = theirs ? [{ actor: 'own', ...mine }, { actor: 'wild', ...theirs }] : [{ actor: 'own', ...mine }];
      if (battle!.format === 'single') {
        if (wild.hp === 0) win();
        else if (combatant.hp === 0) finish('defeat');
        break;
      }
      // Team battle: a fainted creature is replaced by the next one standing, until a side has none left.
      if (wild.hp === 0) {
        battle!.ko.foe += 1;
        battle!.events.push({ side: 'foe', kind: 'faint', creature: wild.id });
        const next = battle!.bench.shift();
        if (!next) { win(); break; }
        battle!.wild = next;
        battle!.events.push({ side: 'foe', kind: 'switch', creature: next.id });
      }
      if (combatant.hp === 0) {
        battle!.ko.own += 1;
        battle!.events.push({ side: 'own', kind: 'faint', creature: combatant.id });
        const next = battle!.roster.map(id => s.creatures.find(c => c.id === id)!).find(c => c.hp > 0);
        if (!next) { finish('defeat'); break; }
        clearBattleOnly(combatant);
        battle!.creatureId = next.id;
        battle!.events.push({ side: 'own', kind: 'switch', creature: next.id });
      }
      break;
    }
    case 'capture': {
      if (!active) fail('no-battle');
      if (battle!.source === 'trainer') fail('not-wild');
      if (s.inventory.capsules === 0) fail('no-capsules');
      if (battle!.wild.hp > 14) fail('not-weakened');
      s.inventory.capsules -= 1;
      // Whatever it was met at, a caught creature is born at level 1: whole HP and charges (owner ruling 2026-10-06).
      const caught = newCreature(battle!.wild.id, battle!.wild.species); caught.nick = cleanNick(command.nick);
      s.creatures.push(caught);
      finish('captured'); battle!.growth = grantXp(combatant, xpGain(5, level(battle!.wild), level(combatant))); s.captures += 1;
      break;
    }
    case 'escape':
      if (!active) fail('no-battle');
      finish('escaped'); break;
    case 'heal':
      s.creatures.forEach(c => { const fresh = newCreature(c.id, c.species, undefined, level(c)); c.hp = maxHp(c); c.charges = fresh.charges; clearBattleOnly(c); });
      s.trainersBeaten = [];
      break;
    case 'scarecrow-gift': {
      if (!Number.isSafeInteger(command.now) || command.now < 0 || command.now > Number.MAX_SAFE_INTEGER - SCARECROW_COOLDOWN_MS) fail('invalid-command');
      if (command.now < s.scarecrowReadyAt) fail('gift-cooldown');
      s.inventory.capsules += SCARECROW_CAPSULES;
      s.scarecrowReadyAt = command.now + SCARECROW_COOLDOWN_MS;
      break;
    }
    case 'grant-skin': {
      if (!(SKINS as readonly string[]).includes(command.skin)) fail('invalid-command');
      // A skin is owned once: a second payment for it is refused before it is taken (dsm.ts).
      if (s.skins.includes(command.skin)) fail('skin-owned');
      const key = `payment/${command.fact}`;
      if (!command.fact.trim() || s.consumed.includes(key)) fail('choice-consumed');
      s.consumed.push(key);
      s.skins.push(command.skin);
      break;
    }
    case 'wear-skin': {
      if (command.skin !== null && !(SKINS as readonly string[]).includes(command.skin)) fail('invalid-command');
      if (command.skin !== null && !s.skins.includes(command.skin)) fail('skin-not-owned');
      s.skin = command.skin;
      break;
    }
    case 'grant-capsule':
    case 'grant-item': {
      const item = command.type === 'grant-item' ? command.item : 'capsule';
      const qty = command.type === 'grant-item' ? command.qty ?? 1 : 1;
      if (!SHOP_ITEM_IDS.includes(item)) fail('invalid-command');
      if (!Number.isInteger(qty) || qty < 1 || qty > SHOP_QTY_MAX) fail('invalid-command');
      // The Ranger's Map is not sold for now (owner, 2026-10-08), whatever the player holds.
      if (item === 'map') fail('unavailable');
      const key = `payment/${command.fact}`;
      if (!command.fact.trim() || s.consumed.includes(key)) fail('choice-consumed');
      s.consumed.push(key);
      if (item === 'capsule') s.inventory.capsules += qty; else s.inventory[item] += qty;
      break;
    }
    case 'sell': {
      if (active) fail('battle-active');
      const i = s.creatures.findIndex(c => c.id === command.creatureId);
      if (i < 0) fail('unknown-creature');
      // The lead fights for you and the last creature is your party: Bramble buys neither.
      if (i === s.lead || s.creatures.length <= 1) fail('not-for-sale');
      const key = `sale/${command.fact}`;
      if (!command.fact.trim() || s.consumed.includes(key)) fail('choice-consumed');
      s.consumed.push(key);
      const lead = s.creatures[s.lead];
      s.creatures.splice(i, 1);
      s.lead = s.creatures.indexOf(lead);
      break;
    }
    case 'bind-creature': {
      const creature = s.creatures.find(c => c.id === command.creatureId);
      if (!creature || creature.anchor !== null || !command.anchor.trim()) fail('invalid-command');
      if (s.creatures.some(c => c.anchor === command.anchor)) fail('invalid-command');
      creature!.anchor = command.anchor; break;
    }
    case 'holdings': {
      if (!Number.isSafeInteger(command.coins) || command.coins < 0) fail('invalid-command');
      s.coins = command.coins;
      // A creature whose object the wallet no longer holds has left with it. One never bound
      // stays, and so does one on its way to the wallet that has not reached a proof yet.
      const kept = s.creatures.filter(
        c => c.anchor === null || command.held.includes(c.anchor) || command.inFlight.includes(c.anchor),
      );
      if (kept.length === 0) fail('invalid-command');
      if (s.battle && !kept.some(c => c.id === s.battle!.creatureId)) fail('battle-active');
      // The lead stays with its creature; one that left hands the lead to the first kept.
      s.lead = Math.max(0, kept.findIndex(c => c.id === lead.id));
      s.creatures = kept;
      break;
    }
    case 'receive-creature': {
      const c = creatureSchema.parse(command.creature);
      if (c.anchor === null || s.creatures.some(x => x.anchor === c.anchor || x.id === c.id)) fail('invalid-command');
      s.creatures.push(c); break;
    }
    case 'campaign': {
      if (!['sanctuary', 'rangers'].includes(command.branch)) fail('invalid-command');
      const opportunity = `${s.campaign.instance}/crossroads`;
      if (s.campaign.branch !== 'unselected' || s.consumed.includes(opportunity)) fail('choice-consumed');
      s.campaign.branch = command.branch;
      s.consumed.push(opportunity);
      break;
    }
    default: fail('invalid-command');
  }
  s.revision += 1; s.commandIds.push(commandId);
  return stateSchema.parse(s);
}
