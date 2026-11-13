<script setup lang="ts">
import { computed, inject, ref, watch, onUnmounted, onMounted } from 'vue';
import { Direction } from '@rpgjs/common';
import { heldDirection, type MovementControls } from './held-direction';
import Joystick from './Joystick.vue';
import ReportTab from './ReportTab.vue';
import { BattleFx, type Stage } from './battle-fx';
import type { ReportList } from '../domain/reports';
import { rodPixels } from './fishing-rod';
import { SPECIES, TRAINERS, LOOKS, SKIN_NAMES, skinPicture, lookPortrait, ITEMS as ITEM_EFFECTS, TEAM_SIZE, NICK_MAX, XP_PER_LEVEL, LEVEL_CAP, multiplier, displayName, level, maxHp, maxCharges, damageBonus, type GameState, type Element, type MoveFx } from '../domain/game';
const xpLabel = (c: { xp: number }) => level(c) >= LEVEL_CAP ? 'MAX' : `${c.xp % XP_PER_LEVEL}/${XP_PER_LEVEL} XP`;
const xpPct = (c: { xp: number }) => (level(c) >= LEVEL_CAP ? 1 : (c.xp % XP_PER_LEVEL) / XP_PER_LEVEL) * 100 + '%';
const growth = computed(() => { const g = props.state.battle?.growth; return g && g.to > g.from ? g : null; });
const growthSeen = ref('');
import { TRAINER_REWARD, VICTORY_REWARD } from '../integrations/dsm/terms';
const props = defineProps<{ state: GameState; mode: string; lastAction?: string; error?: string; notice?: string; nearPond?: boolean; nearNpc?: string; atShop?: boolean; door?: boolean; encounter?: { title: string; line: string } | null; fishing?: { phase: 'cast' | 'bite'; dx: number; dy: number } | null; walletCoins?: number | null; walletWaiting?: string | null; trainerBeaten?: boolean; reportList?: ReportList | null;
  /** Player-vs-player: the opponent, the stake, this turn's deadline, and whether we wait on them. */
  pvp?: {
    opponent: string; stake: number; deadline: number; waiting: boolean; chosen?: boolean; foeReady?: boolean; reason: string | null;
    /** A staked match: each move sealed, then revealed, by its own player's wallet; settled by the program. */
    staked?: { sealed: { mine: boolean; theirs: boolean }; revealed: { mine: boolean; theirs: boolean }; entries: number; outcome: string | null; paid: boolean; problem: string } | null;
  } }>();
const useItem = ref<'poultice' | 'tonic' | null>(null);
const wallet = computed(() => props.walletCoins ?? props.state.coins);
const usable = (id: string): id is 'poultice' | 'tonic' => id === 'poultice' || id === 'tonic';
const toggleUse = (id: string) => { useItem.value = !usable(id) || useItem.value === id ? null : id; };
const trainer = computed(() => props.state.battle?.trainer ? TRAINERS[props.state.battle.trainer] : null);
const nearTrainer = computed(() => Object.values(TRAINERS).some(t => t.name === props.nearNpc));
const interact = inject<(id: string, action: string, data: unknown) => void>('rpgGuiInteraction')!;
const EL: Record<Element, { label: string; color: string; bg: string }> = {
  fire: { label: 'FIRE', color: '#b5522a', bg: '#7a3b1e' }, grass: { label: 'GRASS', color: '#3f8a4f', bg: '#2f5a2e' },
  water: { label: 'WATER', color: '#2f6f9e', bg: '#244b63' }, electric: { label: 'VOLT', color: '#8a6d1f', bg: '#5a4a14' }, none: { label: 'BASIC', color: '#5b6b60', bg: '#26503c' },
};
const PROJ: Partial<Record<Element, string>> = { fire: 'fire', grass: 'leaf', water: 'water', electric: 'bolt' };
const DESC: Record<string, string> = { strike: '8 damage', flare: '14 fire damage', 'ember-bite': '9 fire · Burn 3×2', 'warm-coat': 'Guard · halve next hit', 'leaf-cut': '12 grass damage', 'root-bind': '6 grass · Root 1 turn', photosynth: 'Heal 12 HP', 'tide-lash': '12 water damage', soak: '7 water · Soak, clears Burn', 'mist-veil': 'Guard · halve next hit', 'volt-charge': '12 volt damage', 'static-tusk': '7 volt · Stun 1 turn', bristle: 'Guard · halve next hit', 'tongue-lash': '12 grass damage', 'sticky-snare': '6 grass · Root 1 turn', camouflage: 'Guard · halve next hit', 'brine-jet': '12 water damage', 'barnacle-bash': '7 water · Soaked 2 turns', 'shell-up': 'Guard · halve next hit', 'chain-whip': '12 water damage', 'lure-flash': '6 water · Stun 1 turn', 'rust-hide': 'Guard · halve next hit' };
/**
 * Where each creature's feet are in its art, measured from the image (lowest solid row, and the
 * middle of the feet): `foot` is the empty share below them, `footX` how far to shift so the feet
 * sit on the image's centre line. Every arena places a creature's feet on the centre of its pad.
 */
const ART: Record<string, { faces: 'left' | 'right'; scale: number; foot: number; footX: number }> = {
  embercub: { faces: 'right', scale: 1.25, foot: 8.2, footX: -9.5 }, mossling: { faces: 'left', scale: 1.3, foot: 1.4, footX: 1.1 },
  tidefin: { faces: 'left', scale: 1.15, foot: 6.3, footX: 13.8 }, voltusk: { faces: 'left', scale: 1.2, foot: 5.7, footX: 1.2 },
  leon: { faces: 'right', scale: 1.25, foot: 0.1, footX: -8.2 }, brineback: { faces: 'left', scale: 1.25, foot: 0.1, footX: -8.9 },
  rattlefin: { faces: 'left', scale: 1.3, foot: 0.1, footX: -12.3 },
};
const pose = (sp: string, side: 'own' | 'wild') => ({ '--flip': flip(sp, side), '--foot': `${ART[sp]?.foot ?? 0}%`, '--footX': `${ART[sp]?.footX ?? 0}%`, scale: ART[sp]?.scale });
const ITEMS = (s: GameState) => [
  { id: 'rod', name: 'Fishing Rod', qty: s.inventory.rod ? 1 : 0, desc: 'Stand at the pond edge and tap CAST.' },
  { id: 'capsule', name: 'Capture Capsule', qty: s.inventory.capsules, desc: 'Throw at a weakened creature (14 HP or less).' },
  { id: 'poultice', name: 'Herb Poultice', qty: s.inventory.poultice, desc: 'Restores 15 HP to one creature.' },
  { id: 'tonic', name: 'Charge Tonic', qty: s.inventory.tonic, desc: 'Restores every move charge of one creature.' },
  { id: 'map', name: 'Ranger’s Map', qty: s.inventory.map, desc: 'Reveals the path past the meadow.' },
];
/** Attack choreography per move fx; the reducer already resolved the numbers. */
async function playAttack(f: MoveFx | undefined, el: Element, dir: 'own' | 'wild') {
  if (f === 'bite') await set('lunge', { melee: true, fxKind: 'bite' }, 300);
  else if (f === 'tongue') await set('tongue', { fxKind: 'tongue' }, 520);
  else if (f === 'jet') await set('jet', { fxKind: 'jet' }, 520);
  else if (f === 'chain') await set('chain', { fxKind: 'bash' }, 520);
  else if (f === 'lure') await set('lure', { fxKind: 'tusk' }, 800);
  else if (f === 'snare') await set('proj', { fxKind: 'snare' }, 420);
  else if (f === 'bash' || f === 'tusk') await set(dir === 'own' ? 'lunge' : 'counter', { melee: true, fxKind: f }, 300);
  else if (PROJ[el]) await set('proj', { fxKind: 'proj' }, 420);
  else await set('lunge', { melee: false, fxKind: 'melee' }, 300);
}
/**
 * A pond battle is fought on the water. Every other battle moves on to the next of the dry arenas,
 * in turn, and keeps it for the whole battle, every creature of a team included. The place in the
 * rotation is remembered on this device.
 */
const DRY_ARENAS = ['forest', 'desert', 'ring'] as const;
const ARENA_KEY = 'wildstate.arena';
const arenaKind = ref<'water' | (typeof DRY_ARENAS)[number]>(DRY_ARENAS[0]);
watch(() => [props.state.battle?.id, props.state.battle?.source] as const, ([id, source]) => {
  if (!id) return;
  if (source === 'pond') { arenaKind.value = 'water'; return; }
  let seen = { id: '', i: -1 };
  try { seen = { ...seen, ...JSON.parse(localStorage.getItem(ARENA_KEY) ?? '{}') }; } catch { /* storage unavailable: start the rotation here */ }
  if (seen.id !== id) {
    seen = { id, i: (seen.i + 1) % DRY_ARENAS.length };
    try { localStorage.setItem(ARENA_KEY, JSON.stringify(seen)); } catch { /* storage unavailable */ }
  }
  arenaKind.value = DRY_ARENAS[seen.i] ?? DRY_ARENAS[0];
}, { immediate: true });
const flip = (sp: string, side: 'own' | 'wild') => (ART[sp]?.faces ?? 'right') === (side === 'own' ? 'right' : 'left') ? 'none' : 'scaleX(-1)';

const view = ref<GameState>(JSON.parse(JSON.stringify(props.state)));
const inBattle = () => props.mode === 'battle' || props.mode === 'pvp';
const busy = ref(inBattle()), message = ref(props.pvp && props.state.battle ? `@${props.pvp.opponent} sends out ${displayName(props.state.battle.wild)}!` : trainer.value && props.state.battle ? `${trainer.value.name} sends out ${displayName(props.state.battle.wild)}!` : 'A wild creature appeared!'), party = ref(false), tab = ref<'creatures' | 'items' | 'wallet' | 'report'>('creatures');
/** The creature just caught, waiting for the player to name it (or not). */
const naming = ref<string | null>(null), nick = ref('');
const renaming = ref<string | null>(null), newNick = ref('');
const fx = ref<{ kind: string; el: Element; dir: 'own' | 'wild'; dmg?: number; crit?: boolean; melee?: boolean; fxKind?: string }>({ kind: '', el: 'none', dir: 'own' });
/** Whose creature the other one is, for messages. */
const foeOwner = computed(() => props.pvp ? `@${props.pvp.opponent}’s` : trainer.value ? `${trainer.value.name}’s` : 'Wild');
const foeTrainer = computed(() => props.pvp ? `@${props.pvp.opponent}` : trainer.value?.name ?? 'The trainer');
/** Seconds left to choose this match turn. */
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { clockTimer = setInterval(() => { clock.value = Date.now(); }, 500); });
onUnmounted(() => clearInterval(clockTimer));
const secondsLeft = computed(() => props.pvp ? Math.max(0, Math.ceil((props.pvp.deadline - clock.value) / 1000)) : 0);
/** The player ran or forfeited: their creature went back into its capsule and stays there. */
const recalled = computed(() => props.lastAction === 'escape' && fx.value.kind !== 'recall' && (view.value.battle?.outcome === 'escaped' || (!!props.pvp && view.value.battle?.outcome === 'defeat')));
/** The look tapped in the picker, before it is confirmed. */
const picked = ref<(typeof LOOKS)[number] | null>(null);
const speaker = computed(() => props.state.battle?.trainer && fx.value.dir === 'wild' ? props.state.battle.trainer : lookPortrait(props.state.look ?? 'classic'));
const own = computed(() => view.value.creatures.find(c => c.id === view.value.battle?.creatureId) ?? view.value.creatures[0]);
const wild = computed(() => view.value.battle?.wild);
const active = computed(() => view.value.battle?.outcome === 'active');
const ownSp = computed(() => SPECIES[own.value.species]);
const wildSp = computed(() => SPECIES[wild.value?.species ?? 'mossling']);
const moves = computed(() => ownSp.value.moves.map(m => {
  const left = m.max ? own.value.charges[m.id] ?? 0 : null;
  const k = m.dmg ? multiplier(m.el, wildSp.value.el) : 1;
  return { ...m, left, disabled: busy.value || (m.max > 0 && left === 0), desc: DESC[m.id] + (k > 1 ? ' · ×1.5' : k < 1 ? ' · ×0.5' : ''), pips: m.max ? Array.from({ length: m.max }, (_, i) => i < (left ?? 0)) : [] };
}));
const matchup = computed(() => { const k = multiplier(ownSp.value.el, wildSp.value.el); return k > 1 ? 'ADVANTAGE' : k < 1 ? 'DISADVANTAGE' : `${EL[ownSp.value.el].label} vs ${EL[wildSp.value.el].label}`; });
const hpColor = (hp: number) => hp > 20 ? 'linear-gradient(#6cc784,#4da96c)' : hp > 10 ? 'linear-gradient(#e8bd4e,#d9a93a)' : 'linear-gradient(#dc6a4e,#c9553a)';
const captureHint = computed(() => !view.value.inventory.capsules ? 'None left' : (wild.value?.hp ?? 0) > 14 ? 'Weaken to 14 HP' : 'Ready to throw');
const canCapture = computed(() => !busy.value && view.value.inventory.capsules > 0 && (wild.value?.hp ?? 99) <= 14);
const statuses = (c: { guard: boolean; statuses: { id: string; turns: number }[] }) => [...(c.guard ? [{ id: 'GUARD', turns: '' }] : []), ...c.statuses.map(x => ({ id: x.id.toUpperCase(), turns: String(x.turns) }))];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The arena's effects canvas (src/gui/battle-fx.ts), and where its creatures stand. */
const arenaEl = ref<HTMLDivElement>(), fxCanvas = ref<HTMLCanvasElement>(), ownImg = ref<HTMLImageElement>(), wildImg = ref<HTMLImageElement>();
let effects: BattleFx | null = null;
function stage(): Stage | null {
  if (!arenaEl.value || !ownImg.value || !wildImg.value) return null;
  const a = arenaEl.value.getBoundingClientRect(), o = ownImg.value.getBoundingClientRect(), w = wildImg.value.getBoundingClientRect();
  const centre = (r: DOMRect) => ({ x: r.left - a.left + r.width / 2, y: r.top - a.top + r.height * 0.55 });
  return {
    own: centre(o), wild: centre(w), ownSize: o.width, wildSize: w.width,
    capsuleRest: { x: w.left - a.left + w.width / 2, y: w.bottom - a.top - w.height * 0.12 },
    ownRest: { x: o.left - a.left + o.width / 2, y: o.bottom - a.top - o.height * 0.1 },
  };
}
watch(fxCanvas, (c) => { effects?.destroy(); effects = c ? new BattleFx(c, stage) : null; effects?.rest(recalled.value ? 'own' : 'none'); });
// A creature called back stays in its capsule on its pad.
watch(() => recalled.value, (r) => effects?.rest(r ? 'own' : 'none'));
onUnmounted(() => effects?.destroy());
/** Which side's creature is fainting on screen, between its knockout and the next creature coming out. */
const fainting = ref<'own' | 'wild' | null>(null);
let pending: ReturnType<typeof setTimeout> | undefined, entrance: ReturnType<typeof setTimeout> | undefined;
onMounted(() => { if (inBattle()) entrance = setTimeout(() => { busy.value = false; }, 650); });
onUnmounted(() => { clearTimeout(pending); clearTimeout(entrance); });
function action(action: string) {
  if (busy.value) return;
  if (action === 'continue') { interact('creature-battle', 'battle', { action, revision: props.state.revision }); return; }
  busy.value = true;
  interact('creature-battle', 'battle', { action, revision: props.state.revision });
  // A match turn resolves when the opponent has chosen too, however long that takes.
  if (props.pvp) { message.value = `Waiting for @${props.pvp.opponent}…`; return; }
  pending = setTimeout(() => { busy.value = false; message.value = 'No response yet. Try again.'; }, 5000);
}
type ClientEngine = { activeKeyboardControls: () => MovementControls | null; getCurrentPlayer?: () => unknown; sceneMap?: { stopMovement?: (player: unknown) => void } };
const engine = inject<ClientEngine>('rpgEngine');
const heldWalk = heldDirection(() => engine?.activeKeyboardControls() ?? null);
/** The thumbstick's direction, held as one engine input per frame; on release the character stops at once. */
function steer(direction: Direction | null) {
  if (direction) { heldWalk.set(direction); return; }
  stopWalk();
}
function stopWalk() {
  heldWalk.stop();
  // The engine otherwise lets the body glide until its 100 ms no-input watchdog.
  const player = engine?.getCurrentPlayer?.();
  if (player) engine?.sceneMap?.stopMovement?.(player);
}
onUnmounted(stopWalk);
/**
 * A cast at the pond: a rod from the character's hands toward the water, a line and a bobber.
 * Drawn over the map at the character's place on screen, followed every frame while it lasts;
 * on the bite the line pulls taut and the bobber goes under.
 */
const rod = ref<{ hx: number; hy: number; s: number } | null>(null);
let rodFrame = 0;
type Camera = { toScreen(x: number, y: number): { x: number; y: number }; scale: { x: number } };
function camera(): Camera | undefined {
  const find = (n: any): Camera | undefined => {
    if (!n) return undefined;
    if (typeof n.toScreen === 'function' && typeof n.toWorld === 'function') return n;
    for (const c of n.children ?? []) { const f = find(c); if (f) return f; }
    return undefined;
  };
  return find((engine as unknown as { canvasApp?: { stage?: unknown } })?.canvasApp?.stage);
}
/**
 * Where the rod sits, in map pixels from the character's footprint (16 x 16 at x, y). The sprite
 * is drawn from (-8, -24) to (24, 16): head about -20, hands about +3, feet +14. The hand holds the
 * rod beside the body on the side it faces; the tip leans out ahead of the body, never over the
 * face; the bobber floats in the water. Facing down or up, the rod angles off to the side.
 */
const ROD: Record<string, { hand: [number, number]; tip: [number, number]; bob: [number, number] }> = {
  right: { hand: [13, 3], tip: [20, -14], bob: [44, 14] },
  left: { hand: [3, 3], tip: [-20, -14], bob: [-44, 14] },
  down: { hand: [15, 3], tip: [17, -12], bob: [10, 40] },
  up: { hand: [14, 1], tip: [13, -20], bob: [4, -38] },
};
function placeRod() {
  const f = props.fishing, me = engine?.getCurrentPlayer?.() as { x(): number; y(): number } | undefined, cam = camera();
  if (!f || !me || !cam) { rod.value = null; return; }
  const way = ROD[rodWay.value];
  // The hand on a whole map pixel, so the rod's pixels line up with the sprite's.
  const hand = cam.toScreen(Math.round(me.x()) + way.hand[0], Math.round(me.y()) + way.hand[1]);
  rod.value = { hx: hand.x, hy: hand.y, s: cam.scale.x };
  rodFrame = requestAnimationFrame(placeRod);
}
const rodWay = computed(() => { const f = props.fishing; return !f ? 'down' : f.dx > 0 ? 'right' : f.dx < 0 ? 'left' : f.dy < 0 ? 'up' : 'down'; });
/** The rod, line and bobber in map pixels from the hand, for this cast's direction and phase. */
const rodArt = computed(() => rodPixels(ROD[rodWay.value], props.fishing?.phase === 'bite'));
watch(() => props.fishing?.phase, (phase) => { cancelAnimationFrame(rodFrame); if (phase) placeRod(); else rod.value = null; }, { immediate: true });
onUnmounted(() => cancelAnimationFrame(rodFrame));
watch(() => [props.mode, props.state.battle?.outcome, props.encounter, party.value], () => {
  if (props.mode !== 'field' || props.state.battle?.outcome === 'active' || props.encounter || party.value) stopWalk();
});
function field(action: string, data: Record<string, unknown> = {}) { interact('field-hud', 'field', { action, ...data }); }
/** The team for trainer battles: up to three creatures, in the order they were picked. */
const teamSlot = (id: string) => props.state.team.indexOf(id);
function toggleTeam(id: string) {
  const team = props.state.team.filter(x => props.state.creatures.some(c => c.id === x));
  const next = team.includes(id) ? team.filter(x => x !== id) : team.length < TEAM_SIZE ? [...team, id] : team;
  field('set-team', { creatureIds: next });
}
/** Team battle standing: who has fallen on each side, for the pips. */
const teamView = computed(() => {
  const b = view.value.battle;
  if (!b || b.format !== 'team3') return null;
  const own = b.roster.map(id => view.value.creatures.find(c => c.id === id)).filter(Boolean).map(c => ({ id: c!.id, down: c!.hp === 0, active: c!.id === b.creatureId }));
  // The fielded opponent counts once: after the final knockout it is already in ko.foe.
  const foeTotal = b.ko.foe + b.bench.length + (b.wild && b.wild.hp > 0 ? 1 : 0);
  const foe = Array.from({ length: foeTotal }, (_, i) => ({ id: String(i), down: i < b.ko.foe, active: i === b.ko.foe }));
  return { own, foe, ko: b.ko };
});
function startRename(c: { id: string; nick?: string | null }) { renaming.value = c.id; newNick.value = c.nick ?? ''; }
function confirmRename(creatureId: string) { field('rename', { creatureId, nick: newNick.value.trim().slice(0, NICK_MAX) }); renaming.value = null; }
const capture = () => action('capture');
/** Spending a turn on a bag item: pick the item, then which fielded creature gets it. */
const itemMenu = ref<'poultice' | 'tonic' | null>(null), itemsOpen = ref(false);
const ITEM_NAMES = { poultice: 'Herb Poultice', tonic: 'Charge Tonic' } as const;
const fielded = computed(() => {
  const b = view.value.battle;
  const ids = b?.roster.length ? b.roster : b ? [b.creatureId] : [];
  return ids.map(id => view.value.creatures.find(c => c.id === id)!).filter(c => c && c.hp > 0);
});
function useBattleItem(item: 'poultice' | 'tonic', creatureId: string) { itemsOpen.value = false; itemMenu.value = null; action(`item:${item}:${creatureId}`); }
function confirmName() {
  const nickname = nick.value.trim().slice(0, NICK_MAX);
  if (naming.value && nickname) interact('creature-battle', 'battle', { action: 'rename', creatureId: naming.value, nick: nickname, revision: props.state.revision });
  naming.value = null;
}
const set = async (kind: string, extra: Partial<typeof fx.value> = {}, ms = 0) => { fx.value = { ...fx.value, ...extra, kind }; if (kind) effects?.play(fx.value); if (ms) await wait(ms); };

watch(() => [props.state.revision, props.error], async () => {
  // Background DSM work moved the revision; the battle itself did not change, so nothing animates.
  if (props.lastAction === 'sync') { if (!busy.value) view.value = JSON.parse(JSON.stringify(props.state)); return; }
  clearTimeout(pending);
  if (!inBattle()) { view.value = JSON.parse(JSON.stringify(props.state)); return; }
  if (props.error) { message.value = props.error; busy.value = false; return; }
  busy.value = true;
  const next: GameState = JSON.parse(JSON.stringify(props.state));
  const b = next.battle!, ownName = displayName(own.value), wildName = wild.value ? displayName(wild.value) : wildSp.value.name;
  if (props.lastAction && b.log.length && (props.lastAction === 'pass' || props.lastAction.startsWith('item:') || SPECIES[own.value.species].moves.some(m => m.id === props.lastAction))) {
    const mine = b.log.find(e => e.actor === 'own'), theirs = b.log.find(e => e.actor === 'wild');
    /** A turn spent on an item: show it, and take the healed or recharged creature from the new state. */
    const itemTurn = async (entry: NonNullable<typeof b.log[number]>, mine: boolean) => {
      const item = entry.move.slice('item:'.length) as 'poultice' | 'tonic';
      const target = mine ? (props.lastAction ?? '').split(':').slice(2).join(':') : '';
      const who = mine ? next.creatures.find(c => c.id === target) : undefined;
      message.value = mine ? `You used ${ITEM_NAMES[item]} on ${who ? displayName(who) : ownName}.` : `${foeTrainer.value} used ${ITEM_NAMES[item]}.`;
      await set('heal', { el: 'none', dir: mine ? 'own' : 'wild' }, 700);
      if (mine && who && who.id === own.value.id) { own.value.hp = who.hp; own.value.charges = { ...who.charges }; }
      if (!mine && wild.value) { wild.value.hp = b.wild.hp; }
      if (mine && item === 'poultice') message.value += ` +${ITEM_EFFECTS.poultice.heal} HP.`;
      if (entry.burn) { await set('', {}, 300); const t = mine ? wild.value! : own.value; t.hp = Math.max(0, t.hp - entry.burn); message.value = `${mine ? wildName : ownName} takes ${entry.burn} burn damage.`; await set('impact', { el: 'fire', dir: mine ? 'own' : 'wild', dmg: entry.burn, crit: false }, 550); }
      await set('');
    };
    /** A turn its player let run out: the creature does nothing. */
    const passTurn = async (entry: NonNullable<typeof b.log[number]>, mine: boolean) => {
      message.value = mine ? `Time ran out: ${ownName} did nothing this turn.` : `${foeTrainer.value} ran out of time: ${wildName} did nothing.`;
      await wait(900);
      if (entry.burn) { const t = mine ? wild.value! : own.value; t.hp = Math.max(0, t.hp - entry.burn); message.value = `${mine ? wildName : ownName} takes ${entry.burn} burn damage.`; await set('impact', { el: 'fire', dir: mine ? 'own' : 'wild', dmg: entry.burn, crit: false }, 550); }
      await set('');
    };
    const ownTurn = async (mine: NonNullable<typeof b.log[number]>) => {
      if (mine.move === 'pass') return passTurn(mine, true);
      if (mine.move.startsWith('item:')) return itemTurn(mine, true);
      const m = ownSp.value.moves.find(x => x.id === mine.move)!;
      message.value = `${ownName} used ${m.name}!`;
      if (m.max && !mine.skipped) own.value.charges[m.id] = Math.max(0, (own.value.charges[m.id] ?? 0) - 1);
      if (mine.skipped) { message.value = `${ownName} ${own.value.statuses.some(x => x.id === 'stun') ? 'is stunned' : 'is rooted'} and cannot move.`; await wait(700); own.value.statuses = own.value.statuses.filter(x => x.id !== 'root' && x.id !== 'stun'); }
      else if (m.guard) { await set(m.fx === 'camo' ? 'camo' : 'guard', { el: 'none', dir: 'own' }, 700); own.value.guard = true; message.value = `${ownName} braces for the next hit.`; }
      else if (m.heal) { await set('heal', { el: 'none', dir: 'own' }, 700); own.value.hp = Math.min(maxHp(own.value), own.value.hp + m.heal); message.value = `${ownName} recovered ${m.heal} HP.`; }
      else {
        await set('windup', { el: m.el, dir: 'own' }, 380);
        await playAttack(m.fx, m.el, 'own');
        wild.value!.hp = Math.max(0, wild.value!.hp - mine.dmg);
        message.value = mine.mult > 1 ? `Super effective! ${mine.dmg} damage.` : mine.mult < 1 ? `Not very effective… ${mine.dmg} damage.` : `${wildName} took ${mine.dmg} damage.`;
        if (mine.status) { message.value += ` ${wildName} is ${mine.status === 'burn' ? 'burning' : mine.status === 'root' ? 'rooted' : mine.status === 'stun' ? 'stunned' : 'soaked'}.`; wild.value!.statuses = b.wild.statuses; }
        await set('impact', { dmg: mine.dmg, crit: mine.mult > 1 }, mine.mult > 1 ? 650 : 550);
      }
      if (mine.burn) { await set('', {}, 300); wild.value!.hp = Math.max(0, wild.value!.hp - mine.burn); message.value = `${wildName} takes ${mine.burn} burn damage.`; await set('impact', { el: 'fire', dir: 'own', dmg: mine.burn, crit: false }, 550); }
      await set('');
    };
    const foeTurn = async (theirs: NonNullable<typeof b.log[number]>) => {
      await wait(350);
      if (theirs.move === 'pass') return passTurn(theirs, false);
      if (theirs.move.startsWith('item:')) return itemTurn(theirs, false);
      if (theirs.skipped) { message.value = `${wildName} ${wild.value!.statuses.some(x => x.id === 'stun') ? 'is stunned' : 'is rooted'} and cannot move.`; await wait(600); }
      else {
        const wm = wildSp.value.moves.find(x => x.id === theirs.move)!;
        message.value = `${foeOwner.value} ${wildName} used ${wm.name}!`;
        await set('windup', { el: wm.el, dir: 'wild' }, 380); await playAttack(wm.fx, wm.el, 'wild');
        own.value.hp = Math.max(0, own.value.hp - theirs.dmg); own.value.guard = false;
        message.value = `${ownName} took ${theirs.dmg} damage.${theirs.status ? ` ${ownName} is ${theirs.status === 'burn' ? 'burning' : theirs.status === 'root' ? 'rooted' : theirs.status === 'stun' ? 'stunned' : 'soaked'}.` : ''}`;
        if (theirs.status) own.value.statuses = next.creatures.find(c => c.id === own.value.id)?.statuses ?? own.value.statuses;
        await set('impact', { dmg: theirs.dmg, crit: false }, 550);
      }
      if (theirs.burn) { await set('', {}, 300); own.value.hp = Math.max(0, own.value.hp - theirs.burn); message.value = `${ownName} takes ${theirs.burn} burn damage.`; await set('impact', { el: 'fire', dir: 'wild', dmg: theirs.burn, crit: false }, 550); }
    };
    // Turns play in the order the server resolved them: in a match the opponent may act first.
    if (b.log[0]?.actor === 'wild') { if (theirs) await foeTurn(theirs); if (mine && own.value.hp > 0) { await wait(350); await ownTurn(mine); } }
    else { if (mine) await ownTurn(mine); if (theirs && wild.value!.hp > 0) await foeTurn(theirs); }
  } else if (props.lastAction === 'capture') {
    message.value = 'Capsule away!'; await set('cap-throw', { dir: 'own' }, 600); await set('cap-open', {}, 650);
    message.value = '…'; await set('cap-shake', {}, 1400); message.value = 'Gotcha!'; await set('cap-catch', {}, 900);
  } else if (props.lastAction === 'escape') {
    // Run or forfeit: the creature is called back into its capsule, and stays there.
    message.value = props.pvp || trainer.value ? `${displayName(own.value)}, come back!` : 'You slipped away safely.';
    await set('recall', {}, 900);
  }
  // Team battles: say who fainted and who was sent in before the new creature appears.
  for (const e of next.battle?.events ?? []) {
    const who = e.side === 'own' ? next.creatures.find(c => c.id === e.creature) : (e.creature === next.battle!.wild.id ? next.battle!.wild : undefined);
    const name = who ? displayName(who) : e.side === 'own' ? ownName : wildName;
    message.value = e.kind === 'faint' ? `${e.side === 'own' ? name : wildName} fainted!` : e.side === 'own' ? `Go, ${name}!` : `${foeTrainer.value} sends out ${name}!`;
    const side = e.side === 'own' ? 'own' : 'wild';
    if (e.kind === 'faint') { fainting.value = side; effects?.play({ kind: 'faint', el: 'none', dir: side }); }
    else {
      // The next creature comes out at once, so the switch is seen, not only read.
      if (side === 'own') { view.value.creatures = JSON.parse(JSON.stringify(next.creatures)); view.value.battle!.creatureId = e.creature; }
      else if (next.battle && e.creature === next.battle.wild.id) view.value.battle!.wild = JSON.parse(JSON.stringify(next.battle.wild));
      fainting.value = null; effects?.play({ kind: 'send-out', el: 'none', dir: side });
    }
    await wait(900);
  }
  fainting.value = null;
  view.value = next; await set('');
  const outcome = next.battle?.outcome;
  // Named only once it is caught: the capsule is thrown first.
  if (props.lastAction === 'capture' && outcome === 'captured') { naming.value = next.creatures.at(-1)?.id ?? null; nick.value = ''; }
  if (props.pvp && (outcome === 'victory' || outcome === 'defeat')) {
    const why = props.pvp.reason === 'resign' || props.pvp.reason === 'forfeit' ? ' by resignation' : props.pvp.reason === 'hp' ? ' on HP at the turn cap' : props.pvp.reason === 'tiebreak' ? ' on the tiebreak at the turn cap' : '';
    message.value = outcome === 'victory' ? `You beat @${props.pvp.opponent}${why}!` : `@${props.pvp.opponent} wins${why}.`;
    busy.value = false; return;
  }
  message.value = outcome === 'captured' ? `${next.creatures.at(-1)?.nick || wildName} joined your collection! +5 XP · swap leads from the BAG` : outcome === 'victory' ? (trainer.value ? `${wildName} is down! +15 XP · ${TRAINER_REWARD} WILD bounty on its way to your wallet` : `${wildName} fainted. Victory! +10 XP · ${VICTORY_REWARD} WILD on its way to your wallet`)
    : outcome === 'defeat' ? `${ownName} fainted. Mira can help at camp.` : outcome === 'escaped' ? (trainer.value ? 'You forfeited. No bounty.' : 'Back to the meadow.') : 'Choose your next move.';
  busy.value = false;
});
</script>

<template>
  <!-- FIELD HUD (over the engine canvas) -->
  <div v-if="mode === 'field'" class="field">
    <header class="win dark"><div><!-- Static during play: its animation cost the phone half its frame rate. --><img class="hudLogo" src="/brand/logo.png" alt="Wildstate"/><small>{{ `Meadow camp · wallet ${state.holder.slice(0, 8)}… on DSM` }}</small></div><div class="res"><span title="Capture capsules"><span aria-hidden="true">◉</span> {{ state.inventory.capsules }} <small class="px">Capsules</small></span><span class="gold">✦ {{ wallet }} <small class="px">WILD</small></span><button class="px small" :disabled="state.battle?.outcome === 'active'" @click="field('shop')" title="Bramble’s trading post: buy with WILD from your wallet, or sell a creature">SHOP</button><button class="px small" :disabled="state.battle?.outcome === 'active'" @click="field('market')" title="Swap WILD and ERA through SoFi">MARKET</button><button class="px small" :disabled="state.battle?.outcome === 'active'" @click="party = !party">BAG</button><button class="px small arenaBtn" :disabled="state.battle?.outcome === 'active'" @click="field('lobby')" title="Battle other players">ARENA</button></div></header>
    <aside v-if="party" class="win cream party"><div class="row between"><span class="h">{{ tab === 'creatures' ? 'Your creatures' : tab === 'items' ? 'Your bag' : tab === 'report' ? 'Report' : 'Wallet' }}</span><button class="px tiny" @click="party = false">CLOSE</button></div>
      <div class="tabs"><button v-for="t in (['creatures','items','wallet','report'] as const)" :key="t" class="px tab" :class="{ on: tab === t }" @click="tab = t">{{ t.toUpperCase() }}</button></div>
      <template v-if="tab === 'creatures'">
      <div v-for="(c, i) in state.creatures" :key="c.id" class="prow" :class="{ lead: i === state.lead }"><div class="thumb" :style="{ backgroundImage: `url(creatures/${c.species}.png)` }"></div><div class="grow"><div class="row between"><span class="row"><b>{{ displayName(c) }}</b><small v-if="c.nick" class="muted">{{ SPECIES[c.species].name }}</small></span><span class="row"><span class="chip px" :style="{ background: EL[SPECIES[c.species].el].color }">{{ EL[SPECIES[c.species].el].label }}</span><span v-if="i === state.lead" class="chip px lead">LEAD</span><button v-else class="px tiny swap" @click="field('set-lead', { creatureId: c.id })">SWAP IN</button><button class="px tiny swap teamBtn" :class="{ on: teamSlot(c.id) >= 0 }" :disabled="teamSlot(c.id) < 0 && state.team.length >= TEAM_SIZE" @click="toggleTeam(c.id)" :title="'Trainer battles field up to ' + TEAM_SIZE">{{ teamSlot(c.id) >= 0 ? 'TEAM ' + (teamSlot(c.id) + 1) : 'TEAM +' }}</button></span></div>
        <div class="row hp"><span class="px lbl">HP</span><div class="bar"><i :style="{ width: c.hp / maxHp(c) * 100 + '%', background: hpColor(c.hp) }"></i></div><small>{{ c.hp }}/{{ maxHp(c) }}</small></div>
        <div class="row hp xp"><span class="px lbl gold">LV {{ level(c) }}</span><div class="bar"><i class="gold" :style="{ width: xpPct(c) }"></i></div><small>{{ xpLabel(c) }}</small></div>
        <small class="muted">DMG +{{ damageBonus(c) }} · <span v-for="m in SPECIES[c.species].moves.filter(m => m.max)" :key="m.id">{{ m.name }} {{ c.charges[m.id] ?? 0 }}/{{ maxCharges(m, c) }} · </span></small>
        <div v-if="renaming === c.id" class="row rename"><input v-model="newNick" :maxlength="NICK_MAX" :placeholder="SPECIES[c.species].name" autofocus @keydown.enter="confirmRename(c.id)"/><button class="px tiny" @click="confirmRename(c.id)">SAVE</button><button class="px tiny" @click="renaming = null">CANCEL</button></div>
        <div class="row between"><small class="px owner">{{ c.anchor ? `DSM OBJECT ${c.anchor.slice(0, 8)}… IN YOUR WALLET` : 'DELIVERING TO YOUR WALLET…' }}</small><button v-if="renaming !== c.id" class="px tiny" @click="startRename(c)">RENAME</button></div></div></div>
      </template>
      <template v-else-if="tab === 'items'">
      <div v-for="it in ITEMS(state)" :key="it.id" class="prow" :class="{ dim: !it.qty }"><div class="thumb icon" :style="{ backgroundImage: `url(shop/icon-${it.id}.png)` }"></div><div class="grow"><div class="row between"><b>{{ it.name }}</b><span class="row"><span class="px">×{{ it.qty }}</span><button v-if="usable(it.id) && it.qty" class="px tiny swap" @click="toggleUse(it.id)">{{ useItem === it.id ? 'CANCEL' : 'USE' }}</button></span></div><small class="muted">{{ it.desc }}</small>
        <div v-if="useItem === it.id" class="useOn"><small class="px lbl">USE ON</small><button v-for="c in state.creatures" :key="c.id" class="px tiny swap" :disabled="it.id === 'poultice' ? c.hp >= maxHp(c) : false" @click="field('use-item', { item: it.id, creatureId: c.id }); useItem = null">{{ displayName(c) }} · {{ c.hp }}/{{ maxHp(c) }}</button></div></div></div>
      <div class="row between coins"><span>Wild Coin</span><span class="gold">✦ {{ wallet }} WILD</span></div>
      <div class="skinHead row between"><span class="px lbl">HALLOWEEN SKINS</span><button v-if="state.skin" class="px tiny swap" @click="field('wear-skin', { skin: null })">TAKE OFF</button></div>
      <div v-if="!(state.skins ?? []).length" class="prow dim col"><small class="muted">No skins yet. Bramble sells them on his SKINS board.</small></div>
      <div v-for="sk in state.skins ?? []" :key="sk" class="prow skinRow" :class="{ lead: state.skin === sk }"><div class="thumb skinArt" :style="{ backgroundImage: `url(${skinPicture(sk)})` }"></div><div class="grow"><div class="row between"><b>{{ SKIN_NAMES[sk] }}</b><span v-if="state.skin === sk" class="chip px lead">WEARING</span><button v-else class="px tiny swap" @click="field('wear-skin', { skin: sk })">WEAR</button></div><small class="muted">{{ state.skin === sk ? 'This is how you look on the map.' : 'Wear it to change how you look on the map.' }}</small></div></div>
      <button class="px tiny" @click="field('shop'); party = false">VISIT BRAMBLE’S TRADING POST</button>
      </template>
      <template v-else-if="tab === 'report'"><ReportTab :state="state" :report-list="reportList" /></template>
      <template v-else-if="tab === 'wallet'">
      <div class="walletOn">
        <section class="wallet-connection">
          <div class="wallet-status"><i class="dot" aria-hidden="true"></i><b class="px">CONNECTED · DSM</b></div>
          <small class="px lbl">WALLET ID</small>
          <code class="wallet-id">{{ state.holder }}</code>
        </section>
        <div class="wallet-grid">
          <section class="wallet-stat"><small class="px lbl">WILD OWNED</small><b class="wallet-value">✦ {{ wallet }}</b></section>
          <section class="wallet-stat"><small class="px lbl">CREATURE OBJECTS</small><b class="wallet-value">{{ state.creatures.filter(c => c.anchor).length }} / {{ state.creatures.length }}</b></section>
        </div>
        <p class="wallet-note">Your coins and creatures are objects in your DSM wallet. These numbers come from its proofs of what it owns.</p>
        <div class="wallet-grid">
          <section class="wallet-stat"><small class="px lbl">GAME REVISION</small><b class="wallet-value">{{ state.revision }}</b></section>
          <section class="wallet-stat"><small class="px lbl">LAST COMMAND</small><code class="wallet-id">{{ state.commandIds.at(-1)?.split('/').pop() ?? '—' }}</code></section>
        </div>
        <section class="wallet-stat">
          <small class="px lbl">CONSUMED OPPORTUNITIES</small>
          <ul v-if="state.consumed.length" class="wallet-records"><li v-for="k in state.consumed.slice(-4).reverse()" :key="k"><code>{{ k }}</code></li></ul>
          <span v-else class="wallet-note">No opportunities consumed yet.</span>
        </section>
      </div>
      </template>
    </aside>
    <svg v-if="rod" class="fishing" :class="fishing?.phase" :style="{ '--px': rod.s + 'px' }" shape-rendering="crispEdges" aria-hidden="true">
      <g class="rod"><rect v-for="(p, i) in rodArt.rod" :key="i" :x="rod.hx + p.x * rod.s" :y="rod.hy + p.y * rod.s" :width="rod.s + 0.5" :height="rod.s + 0.5" :fill="p.c"/></g>
      <g class="bob"><rect v-for="(p, i) in rodArt.bobber" :key="i" :x="rod.hx + p.x * rod.s" :y="rod.hy + p.y * rod.s" :width="rod.s + 0.5" :height="rod.s + 0.5" :fill="p.c"/></g>
    </svg>
    <!-- The wallet holds a request for the player's approval: nothing else moves until it is answered. -->
    <div v-if="walletWaiting" class="walletWait win cream"><span><b class="px">YOUR DSM WALLET IS WAITING FOR YOU</b><small>{{ walletWaiting }}</small></span><a class="px go" href="dsm:wallet">OPEN WALLET ▶</a></div>
    <!-- The first time the game opens: who you are on the map, in battle and when you talk. Picked once. -->
    <div v-if="state.lookPicked !== true" class="lookPick">
      <div class="lookBox win cream">
        <b class="px t">PICK YOUR TRAINER</b>
        <p>This is who you'll be: on the map, in battle and when you talk. You pick once.</p>
        <div class="looks">
          <button v-for="l in LOOKS" :key="l" class="look" :class="{ on: picked === l }" :aria-pressed="picked === l" @click="picked = l">
            <img :src="`portraits/${lookPortrait(l)}.png`" :alt="`Trainer ${l}`"/>
          </button>
        </div>
        <button class="cmd go" :disabled="!picked" @click="picked && field('set-look', { look: picked })">{{ picked ? 'THIS IS ME ▶' : 'TAP A TRAINER' }}</button>
      </div>
    </div>
    <button v-if="encounter" class="tapCard" @click="field('fight')"><span class="tapBox"><span class="px t">{{ encounter.title }}</span><span class="l">{{ encounter.line }}</span><span class="px tap">TAP TO FIGHT ▶</span></span></button>
    <button v-else-if="door" class="tapCard" @click="field('enter-shop')"><span class="tapBox"><span class="px t">TRADING POST</span><span class="l">Bramble’s door creaks open.</span><span class="px tap">TAP TO ENTER ▶</span></span></button>
    <Joystick v-if="state.battle?.outcome !== 'active' && !encounter && !party && state.lookPicked === true" @direction="steer"/>
    <nav v-if="state.battle?.outcome !== 'active'" class="controls" aria-label="Actions">
      <div class="side"><div v-if="nearNpc || atShop || nearPond" class="hint">{{ (nearTrainer ? (trainerBeaten ? `${nearNpc} is beaten · rest at camp for a rematch` : `${nearNpc} wants a battle · ${TRAINER_REWARD} WILD bounty`) : nearNpc ? (nearNpc === 'Wayfinding sign' ? 'Read the sign' : nearNpc === 'Bulletin board' ? 'This week’s missions' : `Talk to ${nearNpc}`) : atShop ? 'Bramble’s trading post' : nearPond ? 'Cast your line into the pond' : '') }}</div><button class="talk px" :class="{ near: nearNpc && !nearTrainer, fight: nearTrainer, pond: nearPond && !nearNpc }" @click="field(nearTrainer ? 'challenge' : nearPond && !nearNpc ? 'cast' : 'talk')">{{ nearNpc === 'Wayfinding sign' || nearNpc === 'Bulletin board' ? 'READ' : nearTrainer ? 'FIGHT' : nearPond && !nearNpc ? 'CAST' : 'TALK' }}</button></div>
    </nav>
  </div>

  <!-- BATTLE -->
  <div v-else class="battle">
    <div class="card win dark">
      <div class="head px"><span>{{ pvp ? `MATCH · VS @${pvp.opponent.toUpperCase()}` : trainer ? `TRAINER BATTLE · ${trainer.name.toUpperCase()}` : 'WILD ENCOUNTER' }}</span><span class="meta"><span>{{ pvp ? (active ? `${secondsLeft}s` : 'Over') : trainer ? trainer.title : view.battle?.source === 'pond' ? 'Pond' : 'Meadow' }}</span><i>·</i><span>Turn {{ (view.battle?.turn || 0) + 1 }}</span><template v-if="teamView"><i>·</i><span class="koCount">KO {{ teamView.ko.foe }}/{{ teamView.foe.length }}</span></template></span></div>
      <div ref="arenaEl" class="arena" :class="[arenaKind, { shake: fx.kind === 'impact' }]">
        <div class="flash" v-if="fx.kind === 'impact' && fx.crit"></div>
        <img ref="wildImg" class="sprite wild" :class="{ faint: fainting === 'wild', flinch: fx.kind === 'impact' && fx.dir === 'own', windupR: fx.kind === 'windup' && fx.dir === 'wild', suck: fx.kind === 'cap-open', gone: ['cap-shake','cap-catch'].includes(fx.kind) || view.battle?.outcome === 'victory' || view.battle?.outcome === 'captured', counter: fx.kind === 'counter' }" :style="pose(wild?.species || 'mossling', 'wild')" :src="`creatures/${wild?.species || 'mossling'}.png`" :alt="wildSp.name"/>
        <img ref="ownImg" class="sprite own" :class="{ faint: fainting === 'own', flinchL: fx.kind === 'impact' && fx.dir === 'wild', windup: fx.kind === 'windup' && fx.dir === 'own', lunge: fx.kind === 'lunge', recall: fx.kind === 'recall', gone: recalled, camo: fx.kind === 'camo' }" :style="pose(own.species, 'own')" :src="`creatures/${own.species}.png`" :alt="ownSp.name"/>
        <!-- Every effect is drawn on this canvas (src/gui/battle-fx.ts). -->
        <canvas ref="fxCanvas" class="fxCanvas" aria-hidden="true"></canvas>
        <b v-if="fx.kind === 'impact'" class="dmg px" :class="[fx.dir, { crit: fx.crit }]">{{ fx.crit ? '!' : '' }}-{{ fx.dmg }}</b>
        <!-- status windows -->
        <div class="status win cream wildS"><div v-if="teamView" class="pips team" aria-label="Opponent team"><i v-for="f in teamView.foe" :key="f.id" :class="{ down: f.down, on: f.active }"></i></div><div class="row between"><b class="name">{{ wild ? displayName(wild) : wildSp.name }}</b><span class="muted">{{ trainer ? `${trainer.name}’s · Lv ${wild ? level(wild) : 1}` : `Wild · Lv ${wild ? level(wild) : 1}` }}</span></div><div class="chips"><span class="chip px" :style="{ background: EL[wildSp.el].color }">{{ EL[wildSp.el].label }}</span><span v-for="st in statuses(wild || { guard: false, statuses: [] })" :key="st.id" class="chip px ink">{{ st.id }} {{ st.turns }}</span></div><div class="row hp"><span class="px lbl">HP</span><div class="bar"><i :style="{ width: (wild ? wild.hp / maxHp(wild) : 0) * 100 + '%', background: hpColor(wild?.hp || 0) }"></i></div><small><b>{{ wild?.hp }}</b><span class="muted">/{{ wild ? maxHp(wild) : 0 }}</span></small></div></div>
        <div class="status win cream ownS"><div v-if="teamView" class="pips team" aria-label="Your team"><i v-for="f in teamView.own" :key="f.id" :class="{ down: f.down, on: f.active }"></i></div><div class="row between"><b class="name">{{ displayName(own) }}</b><span class="muted">Lv {{ level(own) }} · {{ xpLabel(own) }}</span></div><div class="chips"><span class="chip px" :style="{ background: EL[ownSp.el].color }">{{ EL[ownSp.el].label }}</span><span v-for="st in statuses(own)" :key="st.id" class="chip px ink">{{ st.id }} {{ st.turns }}</span></div><div class="row hp"><span class="px lbl">HP</span><div class="bar"><i :style="{ width: own.hp / maxHp(own) * 100 + '%', background: hpColor(own.hp) }"></i></div><small><b>{{ own.hp }}</b><span class="muted">/{{ maxHp(own) }}</span></small></div></div>
      </div>
      <div class="bottom">
        <div class="msg win dark"><img class="portrait" :src="`portraits/${speaker}.png`" alt=""/><p role="status">{{ message }}</p><small v-if="active" class="px hint">{{ matchup }}</small><span class="cursor">▼</span></div>
        <div v-if="pvp?.staked && !active" class="settleNote win cream">
          <b class="px">SETTLED BY PROGRAM — NO REFEREE</b>
          <small>{{ pvp.staked.outcome ? (pvp.staked.paid ? `The program's result holds the match cell; the winner's wallet collected both stakes.` : `The program's result holds the match cell; the winner's wallet collects both stakes.`) : `The winner's wallet writes both players' signed moves to DSM; the program computes the result from them.` }} {{ pvp.staked.entries }} signed moves.</small>
          <small v-if="pvp.staked.problem" class="muted">{{ pvp.staked.problem }}</small>
        </div>
        <template v-if="active">
          <!-- A match: both players choose at once each turn; this says who the turn is waiting on. -->
          <div v-if="pvp" class="turnBar px" :class="{ mine: !pvp.chosen, theirs: pvp.chosen }">
            <span>{{ pvp.chosen ? `WAITING FOR @${pvp.opponent.toUpperCase()}` : pvp.foeReady ? `@${pvp.opponent.toUpperCase()} IS READY · YOUR MOVE` : 'YOUR MOVE' }}</span><b>{{ secondsLeft }}s</b>
          </div>
          <!-- A staked match: each move is sealed by its player's own wallet, and revealed once both are sealed. -->
          <div v-if="pvp?.staked" class="sealBar px">
            <span :class="{ on: pvp.staked.sealed.mine }"><i class="seal"></i>{{ pvp.staked.revealed.mine ? 'YOURS REVEALED' : pvp.staked.sealed.mine ? 'YOURS SEALED' : pvp.chosen ? 'SEALING…' : 'YOURS OPEN' }}</span>
            <span :class="{ on: pvp.staked.sealed.theirs }"><i class="seal"></i>{{ pvp.staked.revealed.theirs ? 'THEIRS REVEALED' : pvp.staked.sealed.theirs ? 'THEIRS SEALED' : 'THEIRS OPEN' }}</span>
          </div>
          <div class="moves"><button v-for="m in moves" :key="m.id" class="move" :disabled="m.disabled" :style="{ background: EL[m.el].bg, borderLeftColor: EL[m.el].color }" @click="action(m.id)">
            <div class="row between"><b>{{ m.name }}</b><span class="chip px dim">{{ EL[m.el].label }}</span></div><small>{{ m.desc }}</small>
            <div class="row between"><span class="pips"><i v-for="(f, i) in m.pips" :key="i" :class="{ on: f }"></i></span><small class="px tiny">{{ m.max ? `${m.left}/${m.max}` : '∞' }}</small></div></button></div>
          <div class="row gap"><button v-if="!trainer && !pvp" class="cmd grow" :disabled="!canCapture" @click="capture()"><b>◉ Capsule ×{{ view.inventory.capsules }}</b><small>{{ captureHint }}</small></button><button class="cmd grow" :disabled="busy || (!view.inventory.poultice && !view.inventory.tonic)" @click="itemsOpen = !itemsOpen"><b>Items</b><small>Uses your turn</small></button><button class="cmd grow" :disabled="busy" @click="action('escape')"><b>{{ trainer || pvp ? 'Forfeit' : 'Run' }}</b><small>{{ pvp ? 'Concede the match' : trainer ? 'No bounty' : view.battle?.source === 'pond' ? 'To the pond' : 'To the meadow' }}</small></button></div>
        </template>
        <div v-if="itemsOpen && active" class="itemPick win cream">
          <small class="px lbl">USE AN ITEM · YOUR TURN</small>
          <div class="row gap"><button v-for="it in (['poultice', 'tonic'] as const)" :key="it" class="cmd" :class="{ sel: itemMenu === it }" :disabled="!view.inventory[it]" @click="itemMenu = it"><b>{{ ITEM_NAMES[it] }}</b><small>×{{ view.inventory[it] }}</small></button></div>
          <div v-if="itemMenu" class="row gap wrap"><button v-for="c in fielded" :key="c.id" class="cmd" :disabled="busy || (itemMenu === 'poultice' && c.hp >= maxHp(c))" @click="useBattleItem(itemMenu, c.id)"><b>{{ displayName(c) }}</b><small>{{ c.hp }}/{{ maxHp(c) }}</small></button></div>
          <button class="cmd" @click="itemsOpen = false; itemMenu = null">Cancel</button>
        </div>
        <div v-if="growth && growthSeen !== view.battle?.id" class="levelup win cream" @click="growthSeen = view.battle?.id ?? ''">
          <div class="row between"><span class="px lbl gold">✦ LEVEL UP</span><b class="name">Lv {{ growth.from }} <span class="gold">▶</span> Lv {{ growth.to }}</b></div>
          <div class="row gap stats"><span><small class="muted">MAX HP</small><b>{{ 40 + 4 * (growth.from - 1) }} → {{ 40 + 4 * (growth.to - 1) }}</b></span><span><small class="muted">DAMAGE</small><b>+{{ growth.from - 1 }} → +{{ growth.to - 1 }}</b></span></div>
          <small v-if="(growth.to >= 4 && growth.from < 4) || (growth.to >= 7 && growth.from < 7)" class="green">+1 charge on every special move</small>
          <small class="px owner">XP IS CARRIED ON THE CREATURE’S DSM STATE · TAP TO CONTINUE</small>
        </div>
        <button v-else-if="view.battle?.outcome !== 'active' && !naming" class="cmd go" :disabled="busy" @click="action('continue')">{{ pvp ? 'Back to the lobby ▶' : 'Return to exploring ▶' }}</button>
        <div v-if="naming" class="naming win cream"><small class="px lbl">GOTCHA! NAME YOUR {{ wildSp.name.toUpperCase() }}</small><input v-model="nick" :maxlength="NICK_MAX" :placeholder="wildSp.name" autofocus @keydown.enter="confirmName()"/><div class="row gap"><button class="cmd go grow" @click="confirmName()">Save name ▶</button><button class="cmd" @click="naming = null">Skip</button></div></div>
        <div class="ledger px"><span><em>REV {{ view.revision }}</em><em>{{ view.commandIds.at(-1)?.split('/').pop() }}</em><em>{{ view.consumed.at(-1) ?? '—' }}</em></span><span class="res">◉ {{ view.inventory.capsules }} <span class="gold">✦ {{ view.coins }} WILD</span></span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=VT323&display=swap');
*{box-sizing:border-box}
.field,.battle{font-family:'VT323',ui-monospace,monospace;color:#f3f3df}
.px{font-family:'Silkscreen',monospace;font-size:10px;letter-spacing:0}
.win{border-radius:0}.win.dark{background:#1b3a2ef2;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e,0 0 0 6px #0b1a15}.win.cream{background:#f6efd2;color:#26443a;box-shadow:0 0 0 2px #26443a,0 0 0 4px #e9e0b8,0 0 0 6px #26443a}
button{font:inherit;cursor:pointer;border:0;color:#f3f3df;background:#1f4434;box-shadow:0 0 0 2px #0b1a15,inset 2px 2px 0 #ffffff22,inset -2px -3px 0 #00000055;border-radius:0}button:active:enabled{translate:0 2px;box-shadow:0 0 0 2px #0b1a15,inset 2px 2px 0 #00000055}button:disabled{opacity:.4;cursor:default}
.row{display:flex;align-items:center;gap:8px}.between{justify-content:space-between}.gap{gap:10px}.grow{flex:1}.muted{color:#4c6a5c}.gold{color:#e9d86b}.small{padding:6px 8px}.tiny{font-size:8px;padding:5px 8px}
.chip{padding:3px 6px;color:#f6efd2;border:2px solid #26443a;line-height:1;font-size:9px}.chip.ink{background:#26443a}.chip.dim{background:#0b1a15;border:0;opacity:.85;font-size:8px}
.hp{margin-top:6px}.lbl{font-size:9px;color:#4c6a5c}.bar{flex:1;height:10px;background:#3b3f2e;border:2px solid #26443a}.bar i{display:block;height:100%;transition:width .45s;box-shadow:inset 0 2px 0 #ffffff55}.hp small{font-size:18px;font-variant-numeric:tabular-nums}
/* field */
.field{position:fixed;inset:0;pointer-events:none;font-size:16px}.field header,.field aside,.field nav .side{pointer-events:auto}
header{position:absolute;top:16px;left:16px;right:16px;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px}header b{font-size:11px}.hudLogo{display:block;width:132px;height:auto;margin-bottom:3px}header small{display:block;font-size:14px;color:#b9cdb6;line-height:1}.res{display:flex;align-items:center;gap:10px;font-size:17px;white-space:nowrap}
.party{position:absolute;left:16px;right:16px;top:90px;max-width:420px;padding:12px;display:grid;gap:10px}/* The fishing rod: drawn over the map, under the controls. */
.fishing{position:absolute;inset:0;width:100%;height:100%;z-index:4;pointer-events:none;overflow:visible}
.fishing .rod{animation:castOut .3s steps(3)}
/* The bobber bobs a pixel at a time; on a bite it is pulled under. */
.fishing .bob{animation:bobble 1.1s steps(1) infinite}
.fishing.bite .bob{animation:dunk .3s steps(1) infinite}
@keyframes castOut{from{opacity:0}}@keyframes bobble{50%{transform:translateY(var(--px))}}@keyframes dunk{0%{transform:translateY(var(--px))}50%{transform:translateY(calc(var(--px) * 3));opacity:.6}}
/* The wallet waits on the player: a banner under the header, with the way there. */
.walletWait{position:absolute;left:12px;right:12px;top:150px;z-index:25;display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 12px;pointer-events:auto;box-shadow:0 0 0 2px #26443a,0 0 0 5px #e2c35a}
.walletWait span{display:grid;gap:3px;min-width:0}.walletWait b{font-size:10px;color:#7a3b1e}.walletWait small{font-size:15px;color:#26443a;overflow:hidden;text-overflow:ellipsis}
.walletWait .go{flex:none;padding:9px 10px;font-size:10px;color:#f6efd2;background:#3f6e2a;text-decoration:none;box-shadow:0 0 0 2px #0b1a15}
/* Whose move it is in a match: gold while it is yours, grey while the opponent's. */
.turnBar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;margin:0 6px;font-size:11px;box-shadow:0 0 0 2px #0b1a15}
.turnBar.mine{background:#e2c35a;color:#10261f;animation:blink 1.2s steps(2) 3}.turnBar.theirs{background:#24402f;color:#cfe3cb}.turnBar b{font-size:13px}
/* The trainer picker: over the whole field, before the game starts. */
.lookPick{position:absolute;inset:0;z-index:30;display:grid;place-items:center;padding:16px;background:#081c1ad9;pointer-events:auto}
.lookBox{width:min(440px,100%);padding:14px;display:grid;gap:10px;text-align:center}.lookBox .t{font-size:14px;color:#26443a}.lookBox p{margin:0;font-size:18px;line-height:1.15;color:#26443a}
.lookBox .cmd{justify-self:stretch}.lookBox .cmd:disabled{opacity:.5}
.looks{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.look{padding:0;border:0;background:#ece4c3;box-shadow:0 0 0 2px #26443a;cursor:pointer;aspect-ratio:1145/1374;overflow:hidden}.look img{display:block;width:100%;height:100%;object-fit:cover}.look.on{box-shadow:0 0 0 2px #26443a,0 0 0 5px #e2c35a}.party .h{font-size:22px}.prow{display:flex;align-items:center;gap:10px;padding:8px;background:#ece4c3;box-shadow:0 0 0 2px #26443a}.thumb{width:52px;height:52px;flex:none;background:center/contain no-repeat;image-rendering:pixelated}.prow b{font-size:20px}.prow small.muted{font-size:14px}
.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.tab{padding:7px 4px;color:#26443a;background:#ece4c3;box-shadow:0 0 0 2px #26443a;font-size:9px}.tab.on{background:#26443a;color:#f6efd2}.prow.lead{background:#f3ecc9}.prow.dim{opacity:.45}
.skinHead{margin-top:4px}.thumb.skinArt{background-position:center bottom;image-rendering:auto}.prow.col{display:grid;gap:2px}.chip.lead{background:#e9d86b;color:#26443a}.swap{background:#26503c;padding:2px 6px;font-size:8px}.owner{font-size:7px;color:#6c8a7c;display:block;margin-top:3px}.thumb.icon{width:40px;height:40px}.coins{padding:6px 8px;font-size:16px}.walletOn{display:grid;gap:8px}.dot{width:10px;height:10px;background:#4da96c;box-shadow:0 0 0 2px #26443a;flex:none}
.rename input{font:inherit;font-size:18px;color:#26443a;background:#ece4c3;border:0;box-shadow:0 0 0 2px #26443a;padding:3px 8px;outline:none;flex:1;min-width:0}
.naming{padding:10px 12px;margin:0 6px;display:grid;gap:10px}.naming input{font:inherit;font-size:24px;color:#26443a;background:#ece4c3;border:0;box-shadow:0 0 0 2px #26443a;padding:6px 10px;outline:none;width:100%}
.tapCard{position:absolute;inset:0;z-index:20;display:grid;place-items:center;border:0;padding:0;font:inherit;color:#f3f3df;background:#081c1ad9;cursor:pointer;pointer-events:auto;animation:reveal .35s}.tapBox{text-align:center;display:grid;gap:14px;padding:22px 28px;background:#1b3a2e;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e,0 0 0 6px #0b1a15}.tapBox .t{font-size:12px;color:#c4ec79}.tapBox .l{font-size:26px;line-height:1.1}.tapBox .tap{font-size:9px;color:#d7e6cf;animation:blink 1s steps(1) infinite}.useOn{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}.talk.fight{background:radial-gradient(circle at 40% 30%,#ffffff40,transparent 60%),#b5522a}
.talk.near{background:radial-gradient(circle at 40% 30%,#ffffff40,transparent 60%),#5a9a3a}.talk.pond{background:radial-gradient(circle at 40% 30%,#ffffff40,transparent 60%),#2f6f9e}
/* The row spans the screen's width above the thumbstick: only its buttons take a touch, the rest passes to the stick. */
.controls{position:absolute;left:16px;right:16px;bottom:24px;z-index:6;display:flex;justify-content:flex-end;align-items:flex-end;gap:12px;pointer-events:none}.controls>*{pointer-events:auto}
.side{display:grid;gap:8px;justify-items:end}.hint{font-size:15px;color:#2b1a10;background:#e9dcb4;padding:5px 9px;box-shadow:0 0 0 2px #2b1a10,inset 0 -2px 0 #c9b98a;max-width:200px;text-align:right;line-height:1.15}.talk{width:78px;height:78px;border-radius:50%;font-size:11px;color:#f6efd2;text-shadow:0 1px 0 #2b1a10;background:radial-gradient(circle at 40% 30%,#ffffff40,transparent 60%),#8a5a2a;box-shadow:0 0 0 3px #2b1a10,0 0 0 6px #c9892a,0 0 0 8px #2b1a10,inset 0 4px 0 #ffffff33,inset 0 -5px 0 #00000044,0 3px 0 #0b1a15}.talk:active{translate:0 3px}
/* battle */
.battle{position:fixed;inset:0;display:grid;place-items:center;background:#0e2620;background-image:radial-gradient(#153429 1px,transparent 1px);background-size:8px 8px;pointer-events:auto;font-size:15px;animation:reveal .5s}
.card{width:min(948px,calc(100vw - 24px));background:#142f26;overflow:hidden}
.head{display:flex;justify-content:space-between;align-items:center;background:#1b3a2e;padding:12px 20px;font-size:12px;font-weight:700;border-bottom:4px solid #0b1a15}.meta{display:flex;gap:10px;align-items:center;color:#b9cdb6;font-weight:400}.meta i{opacity:.5;font-style:normal}
.arena{height:min(440px,46vh);position:relative;overflow:hidden;background:0 0/100% 100% no-repeat;image-rendering:pixelated;border-bottom:4px solid #0b1a15}
.arena.shake{animation:shake .4s}.flash{position:absolute;inset:0;background:#fff;pointer-events:none;animation:flash .45s forwards}
.sprite{position:absolute;transform:var(--flip) translate(var(--footX), var(--foot));image-rendering:pixelated;filter:drop-shadow(0 9px 8px #28482c55);transform-origin:bottom center;animation:breathe 2s ease-in-out infinite;transition:opacity .3s}/* Each arena names its pads: the centre of each pad's top face, measured from its art. Creatures stand
   with their feet there. Wide screens use the wide art; there is no wide ring, so a match uses the forest. */
.arena{--ww:18.5%;--ow:25%}
.arena.ring{background-image:url(/tiles/arena-ring-desktop.png);--padWX:67.9%;--padWY:54%;--padOX:30.3%;--padOY:76%}
.arena.forest{background-image:url(/tiles/arena-forest-desktop.png);--padWX:68.4%;--padWY:54.8%;--padOX:28.7%;--padOY:75.2%}
.arena.water{background-image:url(/tiles/arena-water-desktop.png);--padWX:67.7%;--padWY:53.3%;--padOX:30.1%;--padOY:74.8%}
.arena.desert{background-image:url(/tiles/arena-desert-desktop.png);--padWX:68.5%;--padWY:54.5%;--padOX:29.3%;--padOY:74.6%}
/* --sink sets the creatures a little below the pad's centre line, so they stand in the pad rather than on its far edge. */
/* --spread moves them apart, each toward its pad's outer side; the far one less, as it is further back. */
.arena{--sink:4%;--spread:3%}
.sprite.wild{width:var(--ww);left:calc(var(--padWX) - var(--ww) / 2 + var(--spread) * .6);bottom:calc(100% - var(--padWY) - var(--sink))}.sprite.own{width:var(--ow);left:calc(var(--padOX) - var(--ow) / 2 - var(--spread));bottom:calc(100% - var(--padOY) - var(--sink))}
.gone{opacity:0!important}.counter{animation:counter .5s!important}.camo{animation:camoFade 1s ease-in-out!important}.flinch{animation:flinch .5s!important}.flinchL{animation:flinchL .5s!important}.windup{animation:windup .38s ease-in-out!important}.windupR{animation:windupR .38s ease-in-out!important}.lunge{animation:lunge .3s!important}.run{animation:run .65s forwards!important}.suck{animation:suckIn .6s ease-in forwards!important}
.status{position:absolute;z-index:2;width:232px;padding:9px 12px 10px}.wildS{left:30px;top:28px;scale:.9;transform-origin:top left}.ownS{right:30px;bottom:28px}.status .name{font-size:30px;line-height:1}.status .muted{font-size:16px;white-space:nowrap}.chips{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;min-height:18px}



.dmg{position:absolute;z-index:7;left:calc(100% - 208px);top:60px;font-size:26px;color:#fff8d6;text-shadow:2px 2px 0 #0b1a15,-2px 2px 0 #0b1a15,2px -2px 0 #0b1a15,-2px -2px 0 #0b1a15;animation:dmgPop .9s ease-out forwards}.dmg.wild{left:240px;top:160px}.dmg.crit{color:#ffe66b}





.sprite.own.recall{animation:recall .85s ease-in forwards}
/* The effects canvas covers the arena; a fainted creature fades into the motes the canvas draws. */
.fxCanvas{position:absolute;inset:0;width:100%;height:100%;z-index:6;pointer-events:none}
.sprite.faint{animation:faintOut .8s ease-in forwards}
@keyframes faintOut{0%{filter:none}35%{filter:brightness(2.2) grayscale(.6)}100%{filter:brightness(2.6) grayscale(1);opacity:0;translate:0 12%;scale:.9}}
@keyframes recall{0%{filter:none}30%{filter:brightness(2.2) drop-shadow(0 0 10px #ff6a50);scale:1.05}100%{filter:brightness(3) drop-shadow(0 0 10px #ff6a50);scale:0;opacity:0;translate:0 30%}}


.bottom{padding:18px 20px 16px;display:grid;gap:16px}
.msg{display:flex;align-items:center;gap:12px;background:#10261f;padding:10px 14px;min-height:56px;margin:4px 6px 2px}.portrait{width:52px;height:52px;flex:none;object-fit:cover;object-position:50% 8%;image-rendering:pixelated;background:#f6efd2;box-shadow:0 0 0 2px #26443a,0 0 0 4px #9ccf6e}.msg p{font-size:24px;margin:0;flex:1;line-height:1.3}.msg .hint{color:#c4ec79;white-space:nowrap;background:none;box-shadow:none;padding:0;max-width:none}.cursor{color:#c4ec79;font-size:16px;animation:blink 1s steps(1) infinite}
.moves{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:6px}.move{min-width:0;text-align:left;padding:10px 12px;display:grid;grid-template-rows:auto 1fr auto;gap:6px;min-height:112px;border-left:5px solid}.move:hover:enabled{filter:brightness(1.15)}.move>.row{min-width:0;flex-wrap:wrap;gap:4px 8px}.move b{font-size:24px;letter-spacing:.5px;line-height:1;overflow-wrap:anywhere;min-width:0}.move small{font-size:18px;line-height:1.3}.pips{display:flex;gap:3px}.pips i{width:9px;height:9px;border:2px solid #0b1a15;display:block;box-shadow:inset 1px 1px 0 #ffffff55}.pips i.on{background:#edf5e8}
.cmd{padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 6px}.cmd b{font-size:21px}.cmd small{font-size:18px;color:#c7d8c2;white-space:nowrap}.cmd.go{justify-content:center;background:#3f6e2a;padding:14px;font-size:22px}
.ledger{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:2px dashed #26443a;padding:10px 6px 0;font-size:8px;color:#8fb09a;white-space:nowrap}.ledger em{font-style:normal;padding:3px 6px;background:#0b1a15;margin-right:6px}.ledger em:first-child{color:#c4ec79}.ledger .res{font-family:'VT323',monospace;font-size:18px;color:#d7e6cf}
@keyframes reveal{from{opacity:0;transform:scale(1.07)}}@keyframes breathe{50%{translate:0 -6px}}@keyframes blink{50%{opacity:0}}@keyframes shake{0%,100%{translate:0 0}20%{translate:-6px 2px}40%{translate:6px -2px}60%{translate:-4px 1px}80%{translate:4px -1px}}@keyframes flash{0%,100%{opacity:0}30%{opacity:.9}}
@keyframes windup{0%{translate:0 0}40%{translate:-18px 4px}70%{translate:28px -10px}100%{translate:0 0}}@keyframes windupR{0%{translate:0 0}40%{translate:18px -4px}70%{translate:-28px 10px}100%{translate:0 0}}@keyframes lunge{50%{translate:75px -20px}}@keyframes run{to{translate:-280px 0;opacity:0}}
@keyframes flinch{0%,100%{translate:0 0;filter:none}20%{translate:14px -4px;filter:brightness(3)}40%{translate:-8px 2px;filter:brightness(1)}60%{translate:6px 0;filter:brightness(2.5)}80%{translate:-3px 0;filter:none}}@keyframes flinchL{0%,100%{translate:0 0;filter:none}20%{translate:-14px 4px;filter:brightness(3)}40%{translate:8px -2px;filter:brightness(1)}60%{translate:-6px 0;filter:brightness(2.5)}80%{translate:3px 0;filter:none}}
@keyframes dmgPop{0%{opacity:0;translate:0 10px;scale:.6}25%{opacity:1;scale:1.25}50%{scale:1}100%{opacity:0;translate:0 -40px}}
@keyframes counter{50%{translate:-65px 30px}}@keyframes camoFade{0%,100%{opacity:1}50%{opacity:.15;filter:saturate(.3)}}

@keyframes suckIn{40%{opacity:.9;filter:brightness(2.5) saturate(0)}100%{opacity:0;scale:.05;translate:-30px 60px;filter:brightness(3) saturate(0)}}
@media(max-width:650px){.arena{height:380px}.status{width:176px;padding:7px 10px 8px}.wildS{left:12px;top:12px}.ownS{right:12px;bottom:12px}.status .name{font-size:22px}.moves{grid-template-columns:1fr 1fr;gap:10px}.move{min-height:58px}.move b{font-size:20px}.move small{font-size:15px}.msg p{font-size:18px}.bottom{padding:10px 14px}.head{padding:10px 14px}header{top:8px;left:8px;right:8px}}
/* Phones: the drop's layout as designed. Long move text wraps and the ledger clips inside the
   width instead of widening their columns past the screen; the capsule and run buttons put their
   line under their name, whole; the heading leaves room for the DSM button. */
@media(max-width:650px){.bottom{grid-template-columns:minmax(0,1fr)}.moves{grid-template-columns:repeat(2,minmax(0,1fr))}.move{min-width:0}.move small{overflow-wrap:anywhere}.cmd{min-width:0}.cmd.grow:not(.go){flex-direction:column;align-items:flex-start;justify-content:center;gap:2px}.cmd small{white-space:normal;text-align:left}.ledger{overflow:hidden}.ledger>span{min-width:0;overflow:hidden;text-overflow:ellipsis}.battle .head{padding-right:112px;gap:10px}}
@media(max-width:650px){header{flex-wrap:wrap;gap:6px;padding:6px 8px}header>div:first-child{flex:1 1 100%;min-width:0;padding-right:92px}header small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.res{flex:1 1 100%;justify-content:flex-end;gap:6px;font-size:15px}.res .small{padding:5px 6px}.party{top:112px}}
.levelup{display:grid;gap:8px;padding:10px 12px;margin:0 6px;cursor:pointer;box-shadow:0 0 0 2px #26443a,0 0 0 4px #e9d86b,0 0 0 6px #26443a;animation:arrive .25s ease-out}.levelup .stats span{flex:1;display:flex;justify-content:space-between;background:#ece4c3;padding:4px 8px;box-shadow:inset 0 0 0 2px #26443a}.levelup .green{color:#3f6e2a}.row.xp .bar{height:6px}.row.xp .bar i.gold{background:#e9d86b}.lbl.gold{color:#8a6d1f}

/* Keep the field controls usable below the optional, compact DSM activity strip. */
.battle{padding-top:var(--dsm-strip-offset,0px);padding-bottom:8px;box-sizing:border-box}
.battle .card{max-height:calc(100svh - var(--dsm-strip-offset,0px) - 16px);overflow-y:auto;scrollbar-width:thin}
.field header,.field .party{transform:translateY(var(--dsm-strip-offset,0px))}
@media(min-width:651px){.field header{padding-right:88px}}

/* Wallet identifiers must wrap inside their card instead of stretching the bag. */
.party{min-width:0;max-height:calc(100svh - 286px - var(--dsm-strip-offset,0px));overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}
.walletOn,.walletOn *{min-width:0}
.walletOn{gap:10px;color:#26443a}
.wallet-connection,.wallet-stat{display:grid;gap:7px;padding:10px;background:#ece4c3;box-shadow:inset 0 0 0 1px #b4ba95}
.wallet-status{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.wallet-status .dot{width:7px;height:7px}
.wallet-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.walletOn .lbl{font-size:8px;line-height:1.5;overflow-wrap:anywhere}
.wallet-id,.wallet-records code{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;word-break:break-word;white-space:normal;color:#385947}
.wallet-value{font-size:23px;line-height:1.1;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.wallet-note{margin:0;font-size:16px;line-height:1.25;color:#4c6a5c}
.wallet-records{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.wallet-records li+li{border-top:1px solid #c6c7a5;padding-top:7px}
@media(max-width:650px){.party{max-height:calc(100svh - 308px - var(--dsm-strip-offset,0px))}}
/* Phones: the battle fills the screen. The arena takes the height the controls leave, and the
   creatures are sized and placed as fractions of it, each beside (never under) its status window:
   the wild one top right of its window, ours bottom left of its own. Effects aim at those spots. */
@media(max-width:650px){
.battle{place-items:stretch;padding-bottom:0}
.battle .card{display:flex;flex-direction:column;width:100%;height:calc(100svh - var(--dsm-strip-offset,0px));max-height:none;box-shadow:none}
.head{flex:none}.bottom{flex:1 1 auto;min-height:0;overflow-y:auto;align-content:start;gap:10px}
.arena{flex:none;height:48svh;min-height:240px;background-size:100% 100%;background-position:0 0}
/* Phone art: the square arenas, with their own pad centres. */
.arena{--ww:30%;--ow:36%}
.arena.forest{background-image:url(/tiles/arena-forest-mobile.png);--padWX:68.7%;--padWY:50.3%;--padOX:31.1%;--padOY:80.7%}
.arena.water{background-image:url(/tiles/arena-water-mobile.png);--padWX:68.6%;--padWY:51.1%;--padOX:29.9%;--padOY:74.8%}
.arena.desert{background-image:url(/tiles/arena-desert-mobile.png);--padWX:68.3%;--padWY:49.4%;--padOX:31.2%;--padOY:78%}
.arena.ring{background-image:url(/tiles/arena-ring-mobile.png);--padWX:68.6%;--padWY:47.4%;--padOX:32.1%;--padOY:79.1%}
.status{width:43%;min-width:0;padding:5px 8px 6px}.status .row.between{flex-wrap:wrap;gap:0 6px}.status .name{font-size:20px}.status .muted{font-size:14px}.status .chips{margin-top:3px;min-height:0;gap:4px}.status .chip{font-size:8px;padding:2px 4px}.status .hp{margin-top:4px;gap:5px}.status .lbl{font-size:8px}.status .bar{height:8px}.status .hp small{font-size:15px}.wildS{left:6px;top:6px}.ownS{right:6px;bottom:6px}

.dmg{left:68%;top:20%;font-size:20px}.dmg.wild{left:16%;top:56%}

.bottom{padding:8px 10px 10px;gap:8px}.msg{min-height:44px;padding:6px 10px;gap:10px;margin:2px 4px 0}.portrait{width:38px;height:38px}.msg p{font-size:17px;line-height:1.15}.msg .hint{font-size:8px}
.moves{gap:8px;padding:4px}.move{min-height:0;padding:6px 8px;gap:3px}.move b{font-size:19px}.move small{font-size:14px;line-height:1.1}.move .tiny{font-size:8px}
.cmd{padding:6px 10px;margin:0 4px}.cmd b{font-size:18px}.cmd small{font-size:14px}.ledger{padding-top:6px}
}
.pips.team{display:flex;gap:4px;margin-bottom:3px}.pips.team i{width:9px;height:9px;border-radius:50%;background:#4da96c;box-shadow:0 0 0 2px #26443a;display:block}.pips.team i.down{background:#7a3b1e;opacity:.6}.pips.team i.on{background:#e9d86b}
.koCount{color:#e9d86b}.teamBtn.on{background:#e9d86b;color:#26443a}
.itemPick{display:grid;gap:8px;padding:10px 12px;margin:0 6px;color:#26443a}.itemPick .cmd{color:#f3f3df}.itemPick .cmd.sel{background:#3f6e2a}.row.wrap{flex-wrap:wrap}
.sealBar{display:flex;gap:10px;justify-content:space-between;font-size:10px;padding:4px 8px;opacity:.85}
.sealBar span{display:flex;align-items:center;gap:6px;opacity:.6}.sealBar span.on{opacity:1}
.sealBar .seal{width:8px;height:8px;border-radius:2px;border:2px solid currentColor;display:inline-block}.sealBar span.on .seal{background:currentColor}
.settleNote{display:flex;flex-direction:column;gap:4px;padding:8px 10px;margin:6px 0}.settleNote b{font-size:11px}
</style>
