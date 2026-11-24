<script setup lang="ts">
/**
 * Bramble's Trading Post, as the design's Shop mobile page lays it out: the
 * interior art, Bramble's line, the BUY / SELL board, a quantity and the
 * confirm. Every number on it is the server's: the board shows the game state
 * and what the wallet owns, as its last proof read. A purchase is WILD the
 * wallet sends, granted once the game's account accepted it; a sale is the
 * creature, an object, sent to the game's account and paid for after.
 */
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import { SKINS, SKIN_NAMES, SPECIES, displayName, level, maxHp, salePrice, skinPicture, SHOP_QTY_MAX, type GameState, type ShopItemId, type Skin } from '../domain/game';
import { ITEM_PRICES, SKIN_PRICE } from '../integrations/dsm/terms';

const props = defineProps<{ state: GameState; coins: number | null; busy: boolean; status: string; say: string; delta: string; deltaAt: number }>();
const interact = inject<(id: string, event: string, data: unknown) => void>('rpgGuiInteraction')!;
const send = (data: Record<string, unknown>) => interact('bramble-shop', 'shop', data);

/** The board: the design's catalogue, with what each item does in this game. */
const CATALOGUE: { id: ShopItemId; name: string; tag: string; desc: string; stock?: number; unavailable?: 'for now' }[] = [
  { id: 'capsule', name: 'Capture Capsule', tag: 'ITEM', desc: 'Catch a weakened creature.' },
  { id: 'poultice', name: 'Herb Poultice', tag: 'HEAL · 1 USE', desc: 'Restore 15 HP to one creature, from the Bag.' },
  { id: 'tonic', name: 'Charge Tonic', tag: 'RESTORE', desc: 'Refill every charge of one creature.' },
  // Not sold for now (owner, 2026-10-08): shown, never buyable, whatever the wallet holds.
  { id: 'map', name: 'Ranger’s Map', tag: 'KEY ITEM · 1', desc: 'Opens the path south of Mira’s camp.', stock: 1, unavailable: 'for now' },
];
/** Served from public/, like every other picture the screens show. */
const INTERIOR = 'shop/interior.png';
const LINES = ['Welcome in, traveller. Everything on the board is for sale — Wild Coin only, no promises.', 'Capsules go fast after a meadow rush. Stock up.', 'Selling a creature transfers it for good. Think it over.'];

const tab = ref<'buy' | 'sell' | 'skins'>('buy');
const sel = ref<string | null>('capsule');
const qty = ref(1);
const line = ref(0);
watch(() => props.say, (s) => { if (s) line.value = -1; });

const owned = (id: ShopItemId) => (id === 'capsule' ? props.state.inventory.capsules : props.state.inventory[id]);
const soldOut = (it: (typeof CATALOGUE)[number]) => it.stock !== undefined && owned(it.id) >= it.stock;
const price = (id: ShopItemId) => Number(ITEM_PRICES[id]);
const coins = computed(() => props.coins ?? 0);
const leadId = computed(() => props.state.creatures[props.state.lead]?.id);
/** Why Bramble will not take this creature, or '' when he will. */
const keep = (c: GameState['creatures'][number]) =>
  c.id === leadId.value ? 'LEAD · KEEP' : props.state.creatures.length <= 1 ? 'LAST · KEEP' : c.anchor === null ? 'ON ITS WAY' : '';

/** The Halloween skins: one of each, worn from the Bag once bought. */
const skinRows = () => SKINS.map((sk: Skin) => {
  const have = (props.state.skins ?? []).includes(sk);
  return { id: sk, name: SKIN_NAMES[sk], tag: 'HALLOWEEN SKIN', desc: have ? 'Yours. Wear it from your Bag.' : 'Changes how you look on the map. Wear it from your Bag.',
    price: Number(SKIN_PRICE), icon: skinPicture(sk), stock: have ? 'owned' : 'one each', off: have, art: true };
});
const rows = computed(() => tab.value === 'skins' ? skinRows() : tab.value === 'buy'
  ? CATALOGUE.map((it) => ({ id: it.id, name: it.name, tag: it.tag, desc: it.desc, price: price(it.id), icon: `shop/icon-${it.id}.png`,
      stock: it.unavailable ? `unavailable ${it.unavailable}` : soldOut(it) ? 'sold' : it.stock !== undefined ? `${it.stock - owned(it.id)} left` : '∞',
      off: it.unavailable !== undefined || soldOut(it) }))
  : props.state.creatures.map((c) => ({ id: c.id, name: displayName(c), tag: keep(c) || SPECIES[c.species].el.toUpperCase(),
      desc: `Lv ${level(c)} · ${c.hp}/${maxHp(c)} HP · transfers ownership`, price: salePrice(c), icon: `creatures/${c.species}.png`,
      stock: keep(c) ? 'not for sale' : 'offer', off: !!keep(c) })));
const chosen = computed(() => rows.value.find((r) => r.id === sel.value && !r.off) ?? null);
const total = computed(() => (chosen.value ? chosen.value.price * (tab.value === 'buy' ? qty.value : 1) : 0));
const paying = computed(() => tab.value !== 'sell');
const cant = computed(() => props.busy || !chosen.value || (paying.value && total.value > coins.value));
const speech = computed(() => props.say && line.value === -1 ? props.say : LINES[Math.max(0, line.value)]);

function pick(r: { id: string; off: boolean }) { if (!r.off && !props.busy) { sel.value = r.id; qty.value = 1; } }
function bump(n: number) { if (tab.value === 'buy') qty.value = Math.max(1, Math.min(SHOP_QTY_MAX, qty.value + n)); }
function setTab(t: 'buy' | 'sell' | 'skins') { tab.value = t; sel.value = t === 'buy' ? 'capsule' : t === 'skins' ? (skinRows().find((r) => !r.off)?.id ?? null) : null; qty.value = 1; }
function confirm() {
  if (cant.value || !chosen.value) {
    if (paying.value && chosen.value && total.value > coins.value) line.value = -2;
    return;
  }
  send(tab.value === 'buy' ? { action: 'buy', item: chosen.value.id, qty: qty.value }
    : tab.value === 'skins' ? { action: 'buy-skin', skin: chosen.value.id }
    : { action: 'sell', creatureId: chosen.value.id });
}
const nextLine = () => { line.value = (Math.max(0, line.value) + 1) % LINES.length; };

// The design is a 402 x 874 phone frame; scale it to the screen without stretching it. Scaling does
// not shrink its layout box, so the frame is centred by its own middle rather than laid out.
const k = ref(1);
const fit = () => { k.value = Math.min(window.innerWidth / 402, window.innerHeight / 874); };
onMounted(() => { fit(); window.addEventListener('resize', fit); });
onUnmounted(() => window.removeEventListener('resize', fit));
</script>

<template>
  <div class="shop">
    <div class="frame" :style="{ transform: `translate(-50%, -50%) scale(${k})` }">
      <img class="interior" :src="INTERIOR" alt="" />
      <i class="lantern"></i>

      <div class="top"><div class="bar">
        <div><div class="px title">TRADING POST</div><div class="sub">Bramble · on DSM</div></div>
        <div class="res"><span>◉ {{ state.inventory.capsules }}</span><span class="px wild">✦ {{ coins === null ? '…' : coins }} WILD</span>
          <span v-if="delta" :key="deltaAt" class="px delta" :class="{ up: delta.startsWith('+') }">{{ delta }}</span></div>
      </div></div>

      <div class="speech" @click="nextLine"><div class="grow"><div class="px who">BRAMBLE · TRADER</div>
        <p>{{ line === -2 ? 'Not enough WILD for that, friend. Win a few bouts first.' : speech }}</p></div><span class="cursor">▼</span></div>

      <div class="tabs">
        <button class="px" :class="{ on: tab === 'buy' }" @click="setTab('buy')">BUY</button>
        <button class="px" :class="{ on: tab === 'sell' }" @click="setTab('sell')">SELL</button>
        <button class="px skinsTab" :class="{ on: tab === 'skins' }" @click="setTab('skins')">SKINS</button>
        <span class="px hint">{{ tab === 'buy' ? 'TAP AN ITEM' : tab === 'skins' ? 'HALLOWEEN LOOKS' : 'TRADE A CREATURE FOR WILD' }}</span>
      </div>

      <div class="board" :class="{ scroll: rows.length > 4 }">
        <button v-for="r in rows" :key="r.id" class="row" :class="{ on: sel === r.id && !r.off, off: r.off }" :disabled="r.off" @click="pick(r)">
          <i class="icon" :class="{ art: 'art' in r }" :style="{ backgroundImage: `url(${r.icon})` }"></i>
          <div class="mid"><div class="name"><b>{{ r.name }}</b><span class="px tag">{{ r.tag }}</span></div><small>{{ r.desc }}</small></div>
          <div class="cost"><div class="px price">✦ {{ r.price }}</div><small>{{ r.stock }}</small></div>
        </button>
      </div>

      <div class="actions">
        <button class="px leave" @click="send({ action: 'leave' })">◀ LEAVE</button>
        <div class="pick"><span>{{ chosen ? chosen.name : tab === 'buy' ? 'Pick an item' : tab === 'skins' ? 'Pick a skin' : 'Pick a creature' }}</span>
          <div v-if="tab !== 'skins'" class="qty"><button class="px" @click="bump(-1)">−</button><span class="px">{{ tab === 'buy' ? qty : 1 }}</span><button class="px" @click="bump(1)">+</button></div></div>
        <button class="px confirm" :class="tab" :disabled="cant" @click="confirm"><span>{{ busy ? '…' : tab === 'sell' ? 'SELL' : 'BUY' }}</span><span class="total">{{ tab === 'sell' ? '+' : '−' }} ✦ {{ total }}</span></button>
      </div>
      <div class="px ledger"><span>REV {{ state.revision }} · {{ state.commandIds.at(-1)?.split('/').pop() ?? '—' }}</span><span class="note">{{ status }}</span></div>
    </div>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=VT323&display=swap');
.shop{position:fixed;inset:0;background:#2a1a10;overflow:hidden;pointer-events:auto;font-family:'VT323',ui-monospace,monospace;font-size:18px;color:#f3f3df}
.frame{position:absolute;left:50%;top:50%;width:402px;height:874px;transform-origin:center;overflow:hidden;background:#2a1a10}
.px{font-family:'Silkscreen',monospace;letter-spacing:0}
button{font:inherit;cursor:pointer;border:0}
button:disabled{cursor:default}
.interior{position:absolute;left:0;top:200px;width:402px;height:714px;image-rendering:pixelated}
.lantern{position:absolute;left:30px;top:240px;width:50px;height:50px;border-radius:50%;background:radial-gradient(#ffcf6a66,transparent 70%);animation:lantern 1.6s infinite;pointer-events:none}
.top{position:absolute;left:0;right:0;top:0;height:200px;background:#1b3a2e;padding:56px 14px 0;box-sizing:border-box}
.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;background:#1b3a2ef2;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e,0 0 0 6px #0b1a15}
.title{font-size:11px;font-weight:700}.sub{font-size:14px;color:#b9cdb6;line-height:1}
.res{position:relative;display:flex;align-items:center;gap:10px;font-size:20px;white-space:nowrap}
.wild{color:#e9d86b;font-size:13px;padding:4px 8px;background:#0b1a15}
.delta{position:absolute;right:0;top:-14px;color:#dc6a4e;font-size:10px;animation:coinPop .9s ease-out forwards}.delta.up{color:#c4ec79}
.speech{position:absolute;left:14px;right:14px;top:124px;display:flex;gap:10px;padding:6px 10px;background:#10261fef;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e,0 0 0 6px #0b1a15;min-height:44px;cursor:pointer;animation:reveal .2s}
.grow{flex:1;min-width:0}.who{font-size:8px;color:#c4ec79;margin-bottom:3px}.speech p{margin:0;font-size:17px;line-height:1.2}
.cursor{align-self:flex-end;color:#c4ec79;font-size:13px;animation:blink 1s steps(1) infinite}
.tabs{position:absolute;left:30px;right:26px;top:452px;display:flex;gap:6px}
.tabs button{font-size:9px;color:#e9dcb4;background:#5a3a1a;padding:6px 12px;box-shadow:0 0 0 2px #2b1a10}.tabs button.on{color:#2b1a10;background:#e9dcb4}.tabs button:active{translate:0 1px}
.hint{margin-left:auto;font-size:7px;color:#e9dcb4;padding:8px 0;opacity:.9;white-space:nowrap}
.board{position:absolute;left:34px;right:30px;top:486px;height:272px;display:grid;grid-template-rows:repeat(4,1fr);gap:4px;padding:6px 4px;box-sizing:border-box;color:#e8e2c8}
.board.scroll{grid-template-rows:none;grid-auto-rows:62px;overflow-y:auto}
.row{text-align:left;color:#e8e2c8;background:transparent;padding:4px 8px;display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:10px;font-family:'VT323',ui-monospace,monospace}
.row.on{background:#2f4a3e;box-shadow:0 0 0 2px #e8e2c8}.row.off{opacity:.45}.row:active:not(:disabled){translate:0 1px}
.icon{width:44px;height:44px;background-size:contain;background-repeat:no-repeat;background-position:center;image-rendering:pixelated;filter:drop-shadow(0 0 2px #0008)}
/* A skin's picture is large art shown small: scaled smoothly, and a little bigger than an item's icon. */
.icon.art{width:52px;height:52px;margin:-4px;image-rendering:auto}
.tabs .skinsTab{background:#8a3a12;color:#ffd7a8}.tabs .skinsTab.on{background:#ffb35c;color:#2b1a10}
.mid{min-width:0}.name{display:flex;align-items:baseline;gap:8px}.name b{font-size:21px;font-weight:400;line-height:1;white-space:nowrap}
.tag{font-size:7px;color:#bcc9a8;white-space:nowrap}.mid small{display:block;font-size:14px;line-height:1.15;color:#c9d4b8;margin-top:3px}
.cost{text-align:right;white-space:nowrap}.price{font-size:12px;color:#ffe08a;text-shadow:1px 1px 0 #0008}.cost small{font-size:13px;color:#bcc9a8}
.actions{position:absolute;left:14px;right:14px;bottom:34px;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:stretch}
.leave{font-size:9px;color:#f3f3df;background:#1f4434;display:grid;place-items:center;padding:0 12px;box-shadow:0 0 0 2px #0b1a15,inset 2px 2px 0 #ffffff22,inset -2px -3px 0 #00000055}
.pick{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:#10261fef;box-shadow:0 0 0 2px #0b1a15;min-height:44px;min-width:0}
.pick>span{font-size:17px;line-height:1.1;min-width:0}
.qty{display:flex;align-items:center;gap:6px}.qty button{font-size:10px;color:#f3f3df;background:#1f4434;width:28px;height:28px;box-shadow:0 0 0 2px #0b1a15}.qty span{font-size:11px;min-width:16px;text-align:center}
.confirm{font-size:9px;color:#f3f3df;background:#3f6e2a;padding:0 12px;min-width:92px;box-shadow:0 0 0 2px #0b1a15,inset 2px 2px 0 #ffffff22,inset -2px -3px 0 #00000055;display:grid;gap:3px;place-items:center;line-height:1}
.confirm.sell{background:#7a3b1e}.confirm:disabled{opacity:.45}.confirm:active:not(:disabled){translate:0 2px}
.total{color:#ffe08a;font-size:11px}
.ledger{position:absolute;left:14px;right:14px;bottom:6px;display:flex;justify-content:space-between;align-items:flex-end;gap:10px;font-size:9px;line-height:1.4;color:#e8e2c8;background:#0b1a15e0;padding:3px 6px}
.ledger>span:first-child{white-space:nowrap}.note{min-width:0;text-align:right}
@keyframes blink{50%{opacity:0}}
@keyframes reveal{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}
@keyframes coinPop{0%{opacity:0;translate:0 8px}30%{opacity:1}100%{opacity:0;translate:0 -30px}}
@keyframes lantern{50%{opacity:.75}}
</style>
