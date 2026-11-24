<script setup lang="ts">
/**
 * The market: trade WILD and ERA at the game's SoFi vaults, from inside the
 * game. The game's account prices a trade from the vaults' public state; the
 * player's wallet carries out an ordinary SoFi trade, routed (and multi-hop
 * when it must be) as SoFi finds it, within what the player granted. Nothing
 * here decides a price or what anyone owns: the reserves are the vaults' own
 * reading, what the player owns is proven, the price is the account's.
 */
import { inject, ref, watch } from 'vue';
import type { MarketData } from '../modules/main/dsm';

const props = defineProps<MarketData>();
const interact = inject<(id: string, event: string, data: unknown) => void>('rpgGuiInteraction')!;
const side = ref<'buy' | 'sell'>('buy');
const amount = ref('');

/** The button just pressed stays down until the game answers: at once, before the server's first word. */
const pressed = ref<'quote' | 'swap' | null>(null);
const send = (action: 'quote' | 'swap' | 'close') => {
  if (action !== 'close') {
    if (props.busy || pressed.value) return;
    pressed.value = action;
    // A tap the game turns down at once (no amount) may not change a word on screen: let go anyway.
    setTimeout(() => { if (!props.busy && pressed.value === action) pressed.value = null; }, 3000);
  }
  interact('dsm-market', 'market', { action, side: side.value, amount: amount.value });
};
// Released once the market is waiting on nothing: an answer, a refusal or a failure.
watch(() => [props.busy, props.status] as const, ([busy]) => { if (!busy && pressed.value) pressed.value = null; });
const held = (action: 'quote' | 'swap') => (props.busy ?? pressed.value) === action;
</script>

<template>
  <div class="overlay">
    <section class="card" aria-label="Market">
      <div class="head">
        <h1>Market · WILD / ERA</h1>
        <button class="x" @click="send('close')">CLOSE</button>
      </div>
      <p class="vault" v-if="vault">The game's {{ vault.vaults }} vaults hold {{ vault.wild }} WILD · {{ vault.era }} ERA · {{ vault.generation }} trade(s) so far</p>
      <p class="vault" v-else>Reading the market's vaults…</p>
      <p class="mine">You own {{ coins ?? '…' }} and {{ era ?? '…' }} (proven).</p>
      <div class="sides">
        <button :class="{ sel: side === 'buy' }" @click="side = 'buy'">BUY WILD with ERA</button>
        <button :class="{ sel: side === 'sell' }" @click="side = 'sell'">SELL WILD for ERA</button>
      </div>
      <label>
        You pay ({{ side === 'buy' ? 'ERA' : 'WILD' }})
        <input v-model="amount" inputmode="decimal" :placeholder="side === 'buy' ? '1.00' : '50'" @keydown.stop />
      </label>
      <div class="actions">
        <button :class="{ held: held('quote') }" :disabled="!!(busy || pressed) && !held('quote')" @click="send('quote')">{{ held('quote') ? 'PRICING…' : 'PRICE' }}</button>
        <button class="go" :class="{ held: held('swap') }" :disabled="!quote || (!!(busy || pressed) && !held('swap'))" @click="send('swap')">{{ held('swap') ? 'TRADING…' : 'TRADE' }}</button>
      </div>
      <p v-if="quote" class="quote">{{ quote.amountIn }} → {{ quote.amountOut }} ({{ quote.hops }} hop{{ quote.hops === 1 ? '' : 's' }})</p>
      <p class="status" aria-live="polite">{{ status }}</p>
      <div v-if="waiting" class="waiting"><span>Waiting for you in your DSM wallet: {{ waiting }}</span><a href="dsm:wallet">OPEN WALLET ▶</a></div>
      <!-- Turning while the game prices a trade or the wallet carries one out: it has not frozen. -->
      <i v-if="busy || pressed" class="spinner" role="progressbar" aria-label="Working"></i>
    </section>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=VT323&display=swap');
.overlay{position:fixed;inset:0;z-index:105;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:#06100cb3;pointer-events:auto;color:#f3f3df;font-family:'VT323',ui-monospace,monospace}
/* Beside the DSM panel (right, 460px) on a wide screen, so both stay in reach. */
@media (min-width:1000px){.overlay{justify-content:flex-start;padding-left:24px}}
.card{position:relative;width:min(520px,100%);padding:16px 18px;background:#10261f;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #e2c35a,0 0 0 6px #0b1a15}
.head{display:flex;justify-content:space-between;align-items:center}
h1{font-family:'Silkscreen',monospace;font-size:14px;color:#f3d77a;margin:0}
.x{font:inherit;font-size:16px;border:0;background:none;color:#cfe3cb;cursor:pointer}
.vault,.mine{margin:6px 0;font-size:20px}
.sides{display:flex;gap:8px;margin:8px 0}
.sides button,.actions button{font:inherit;font-size:18px;flex:1;padding:6px;border:0;cursor:pointer;background:#24402f;color:#e7f6c9}
.sides button.sel{background:#9ccf6e;color:#0e1a14}
label{display:block;font-size:18px;margin:6px 0}
input{display:block;width:100%;box-sizing:border-box;margin-top:4px;font:inherit;font-size:22px;padding:6px 8px;background:#f6efd2;color:#10261f;border:0}
.actions{display:flex;gap:8px;margin-top:8px}
.actions .go{background:#e2c35a;color:#10261f}
.actions button:disabled{opacity:.4}
/* Waiting on the wallet: greyed and pressed in, as if held down. */
.actions button.held{background:#5d6b62;color:#d8e2d3;transform:translateY(2px);box-shadow:inset 0 3px 0 #0b1a1599;cursor:progress;opacity:1}
.quote{font-size:22px;color:#f3d77a;margin:8px 0 0}
.status{font-family:'Silkscreen',monospace;font-size:10px;color:#e7f6c9;min-height:14px;margin-top:8px;padding-right:30px}
.waiting{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:10px;padding:8px 10px;background:#e2c35a;color:#10261f;font-size:17px}.waiting a{flex:none;font-family:'Silkscreen',monospace;font-size:10px;color:#f6efd2;background:#3f6e2a;padding:8px 10px;text-decoration:none}
.spinner{position:absolute;right:12px;bottom:12px;width:20px;height:20px;border-radius:50%;border:3px solid #24402f;border-top-color:#e2c35a;border-right-color:#e2c35a;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
