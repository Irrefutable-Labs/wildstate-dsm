<script setup lang="ts">
/**
 * The DSM overlay: what the game server did (Web2) and what DSM did underneath,
 * as it happens. Closed, the game is just a game; open, every step shows which
 * side it ran on. Its toggle is the player's (the DSM button, or D); the server
 * only feeds it. Every DSM line is the game account's own record of a real
 * call: its route, its economic position before and after, its roots.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { PanelData, OverlayEntry } from '../modules/main/dsm';
import { keepResumeToken } from './resume';

const props = defineProps<PanelData>();

keepResumeToken(() => props.resumeToken);
const open = ref(false);
const filter = ref<'all' | 'dsm' | 'web2'>('all');

const shown = computed(() =>
  [...(props.entries ?? [])].reverse().filter((e: OverlayEntry) => filter.value === 'all' || e.lane === filter.value),
);
const dsmCount = computed(() => (props.entries ?? []).filter((e) => e.lane === 'dsm').length);

function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if ((e.key === 'd' || e.key === 'D') && props.wallet) open.value = !open.value;
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => { window.removeEventListener('keydown', onKey); document.documentElement.classList.remove('dsm-strip-open'); });
watch(open, (value) => document.documentElement.classList.toggle('dsm-strip-open', value));

const seconds = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);
</script>

<template>
  <div class="dsm-root">
    <!-- Only once a wallet is connected: before that it would sit over the connect screen. -->
    <button v-if="!open && wallet" class="toggle" title="Show DSM (D)" aria-controls="dsm-activity" :aria-expanded="open" @click="open = true">
      DSM <small>{{ dsmCount }}</small>
    </button>
    <aside v-if="open" id="dsm-activity" class="panel" aria-label="DSM activity">
      <header>
        <b class="title">DSM <span class="live-dot" aria-hidden="true"></span></b>
        <nav class="filters" aria-label="Activity filter">
          <button :aria-pressed="filter === 'all'" :class="{ sel: filter === 'all' }" @click="filter = 'all'">All</button>
          <button :aria-pressed="filter === 'dsm'" :class="{ sel: filter === 'dsm' }" @click="filter = 'dsm'">Wallet</button>
          <button :aria-pressed="filter === 'web2'" :class="{ sel: filter === 'web2' }" @click="filter = 'web2'">Game</button>
        </nav>
        <button class="close" aria-label="Close DSM activity" title="Close DSM (D)" @click="open = false">×</button>
      </header>
      <div class="summary">
        <span :title="wallet ?? 'Connect your wallet'">{{ wallet ? `Wallet ${wallet.slice(0, 8)}…` : 'Wallet connecting' }}</span>
        <span class="holdings">{{ coins ?? 'Owned: proof pending' }}<template v-if="era"> · {{ era }}</template></span>
        <span v-if="provenAt" class="proof" :title="`Verified at position ${provenAt}`">Verified</span>
      </div>
      <ol class="feed" aria-label="Recent activity">
        <li v-for="e in shown" :key="e.id" :class="[e.lane, e.tone]">
          <details>
            <summary class="row">
              <span class="lane">{{ e.lane === 'dsm' ? 'WALLET' : 'GAME' }}</span>
              <b>{{ e.title }}</b>
              <span v-if="e.ms !== undefined" class="ms">{{ seconds(e.ms) }}</span>
              <span class="chevron" aria-hidden="true">⌄</span>
            </summary>
            <div class="detail">{{ e.detail }}</div>
            <div v-if="e.dsm" class="chain">
              <span>{{ e.dsm.route }}</span>
              <span v-if="e.dsm.positionBefore !== undefined && e.dsm.positionAfter !== undefined">position {{ e.dsm.positionBefore }} → {{ e.dsm.positionAfter }}</span>
              <span v-if="e.dsm.econRoot">Economic root {{ e.dsm.econRoot }}…</span>
              <span v-if="e.dsm.deviceTree">Device tree {{ e.dsm.deviceTree }}…</span>
            </div>
          </details>
        </li>
        <li v-if="!shown.length" class="empty">{{ filter === 'all' ? 'Activity appears here as you play.' : 'No activity in this view yet.' }}</li>
      </ol>
    </aside>
  </div>
</template>

<style scoped>
:global(html.dsm-strip-open){--dsm-strip-offset:calc(clamp(104px,16svh,144px) + 16px)}
.dsm-root{position:fixed;inset:0;pointer-events:none!important;z-index:120;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
button{font:inherit;cursor:pointer;color:#cfe3cb;background:transparent;border:0}
.toggle{pointer-events:auto;position:absolute;top:max(10px,env(safe-area-inset-top));right:max(16px,env(safe-area-inset-right));display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;font-size:11px;font-weight:700;letter-spacing:.04em;background:#233e30;border:1px solid #91b66b;border-radius:5px;box-shadow:0 2px 5px #0005}
.toggle small{font-size:10px;color:#b8cd9d;font-weight:400}
.panel{pointer-events:auto;position:absolute;top:max(8px,env(safe-area-inset-top));left:8px;right:8px;height:clamp(104px,16svh,144px);box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:#102219;color:#d8ead2;border:1px solid #587b48;border-radius:7px;box-shadow:0 3px 10px #0005;font-size:11px}
header{display:flex;align-items:center;gap:12px;flex:none;height:30px;padding:0 8px 0 10px;border-bottom:1px solid #304735}
.title{display:flex;align-items:center;gap:6px;font-size:12px;letter-spacing:.04em;color:#c4ec79}
.live-dot{width:5px;height:5px;background:#9ccf6e;border-radius:50%}
.filters{display:flex;gap:3px}
.filters button{font-size:10px;padding:3px 7px;border-radius:3px;color:#a3b8a0}
.filters button.sel{background:#304b36;color:#eef5df}
.close{margin-left:auto;font-size:23px;line-height:1;width:30px;height:28px;border-radius:3px;color:#c8d9b9}
button:hover{background:#39573e}button:focus-visible,summary:focus-visible{outline:2px solid #c4ec79;outline-offset:-2px}
.summary{display:flex;align-items:center;gap:10px;flex:none;padding:4px 10px;font-size:10px;color:#94ad95;white-space:nowrap;overflow:hidden;border-bottom:1px solid #263d2b}
.summary>span{overflow:hidden;text-overflow:ellipsis}.holdings{color:#e8d991}.proof{margin-left:auto;color:#b9d59e}
.feed{list-style:none;margin:0;padding:2px 6px;overflow:auto;overscroll-behavior:contain;flex:1;min-height:0;scrollbar-width:thin;scrollbar-color:#55784a transparent}
.feed li{border-left:2px solid #6f8290;margin:1px 0;padding:0 6px}.feed li.dsm{border-left-color:#9ccf6e}.feed li.wait{border-left-color:#e2c35a}.feed li.fail{border-left-color:#e06a5a}
.row{display:flex;align-items:center;gap:7px;min-height:24px;cursor:pointer;list-style:none}.row::-webkit-details-marker{display:none}.row b{font-size:11px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lane{font-size:8px;color:#b9d59e;flex:none;letter-spacing:.04em}.web2 .lane{color:#a4b8ce}.ms{margin-left:auto;white-space:nowrap;font-size:9px;color:#8ba08f}.chevron{color:#94ad95;margin-left:auto}details[open] .chevron{rotate:180deg}
.detail{padding:2px 0 5px;color:#c6d8c0;line-height:1.4;overflow-wrap:anywhere;font-size:10px}.chain{padding-bottom:6px;display:flex;flex-wrap:wrap;gap:3px 10px;color:#8ba88d;font-size:9px;overflow-wrap:anywhere}.empty{padding:8px!important;border:0!important;color:#94ad95;font-size:10px}
@media(max-width:400px){header{gap:8px}.summary{gap:6px}.proof{display:none}}
</style>
