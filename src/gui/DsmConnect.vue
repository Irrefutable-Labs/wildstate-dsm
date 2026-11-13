<script setup lang="ts">
/**
 * Connect a DSM wallet: the code the game's account made for this player,
 * as a QR the wallet scans (Apps → SCAN CODE). The wallet fetches the signed
 * offer it names, shows what the game asks for, and the player approves it on
 * the phone. The server closes this once the game's account has the wallet.
 */
import { inject, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { RESUME_KEY, keepResumeToken } from './resume';
import { LOGO_HTML } from './logo';

const props = defineProps<{ code: string; status: string; resumeToken?: string | null }>();
const interact = inject<(id: string, event: string, data: unknown) => void>('rpgGuiInteraction')!;

// A browser that connected before hands the server its resume token: the
// server resumes that connection if the game's account still holds it.
// The login that goes with this code: kept, so a page the phone froze while
// the player was in the wallet picks up the connection when it comes back.
keepResumeToken(() => props.resumeToken);

// The phone freezes this page while the player approves in the wallet, and the
// game server lets its connection go. Coming back, the page joins again; its
// resume token picks up the connection the wallet made.
let hiddenAt: number | null = null;
function onVisibility() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  if (hiddenAt !== null && Date.now() - hiddenAt > 3000) window.location.reload();
  hiddenAt = null;
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility));
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility));

onMounted(() => {
  let token: string | null = null;
  try {
    token = window.localStorage.getItem(RESUME_KEY);
  } catch (e: unknown) {
    console.warn('the resume token could not be read', e);
  }
  if (token) interact('dsm-connect', 'resume', { token });
});
const qr = ref('');
const copied = ref(false);

watch(
  () => props.code,
  async (code) => {
    qr.value = code ? await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 1, width: 320 }) : '';
  },
  { immediate: true },
);

async function copy() {
  await navigator.clipboard.writeText(props.code);
  copied.value = true;
}
</script>

<template>
  <div class="overlay">
    <section class="card" aria-label="Connect your DSM wallet">
      <div class="ws-logo brand" v-html="LOGO_HTML"></div>
      <h1>Connect your DSM wallet</h1>
      <p class="lead">Wildstate keeps running as a normal game. What you catch and earn is yours: objects in your wallet.</p>
      <!-- On this phone: the link opens the DSM wallet with the code filled in. -->
      <a v-if="code" class="open" :href="code">OPEN DSM WALLET</a>
      <p v-if="code" class="or">On another device: scan this code.</p>
      <div class="qr">
        <img v-if="qr" :src="qr" alt="Connect code" />
        <div v-else class="wait">…</div>
      </div>
      <ol>
        <li>On this phone, tap <b>OPEN DSM WALLET</b>. On another, open DSM, then <b>APPS</b> → <b>SCAN CODE</b>.</li>
        <li>Read what Wildstate asks for: accept its creatures, send it WILD, trade WILD and ERA, prove what you own, stake on arena matches, see your contacts.</li>
        <li>Approve. After that the game asks your wallet itself; anything else waits on your phone.</li>
      </ol>
      <p class="status" aria-live="polite">{{ status }}</p>
      <button v-if="code" class="copy" @click="copy">{{ copied ? 'Copied' : 'Copy the code text' }}</button>
    </section>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=VT323&display=swap');
.overlay{position:fixed;inset:0;z-index:110;display:flex;align-items:safe center;justify-content:center;overflow-y:auto;padding:16px;box-sizing:border-box;background:#06100cd9;pointer-events:auto;color:#f3f3df;font-family:'VT323',ui-monospace,monospace}
.brand{width:min(78%,360px);margin:2px auto 10px}
.card{width:min(560px,100%);padding:18px 20px;background:#10261f;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e,0 0 0 6px #0b1a15;text-align:center}
h1{font-family:'Silkscreen',monospace;font-size:16px;color:#c4ec79;margin:0 0 6px}
.lead{margin:0 0 12px;font-size:20px;color:#cfe3cb}
.qr{display:flex;justify-content:center;margin:8px 0 12px}
.qr img{width:min(300px,60vw);height:auto;image-rendering:pixelated;background:#fff;padding:6px}
.wait{width:220px;height:220px;display:flex;align-items:center;justify-content:center;font-size:40px;color:#9ccf6e}
ol{text-align:left;margin:0 auto 10px;padding-left:22px;font-size:19px;line-height:1.25;max-width:480px}
.status{font-family:'Silkscreen',monospace;font-size:10px;color:#e7f6c9;min-height:14px}
.open{display:block;margin:4px auto 6px;max-width:320px;padding:12px;background:#e2c35a;color:#10261f;font-family:'Silkscreen',monospace;font-size:14px;text-decoration:none}
.or{margin:0 0 4px;font-size:18px;color:#cfe3cb}
.copy{font:inherit;font-size:16px;margin-top:6px;padding:4px 10px;border:0;cursor:pointer;background:#9ccf6e;color:#0e1a14}
</style>
