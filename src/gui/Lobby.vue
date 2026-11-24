<script setup lang="ts">
/**
 * The arena lobby: pick a name, wait for the matchmaker, or challenge a friend by username or DSM
 * ID. Every number here is the server's. Your DSM passport is who you are; your username is how
 * friends find you, and changing it keeps your rating and history.
 */
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';

type Brief = { id: string; name: string; rating: number; online: boolean };
const props = defineProps<{
  now: number;
  me: { id: string; name: string | null; rating: number; wins: number; losses: number; games: number; renameReadyAt: number };
  stakes: number[]; maxStake: number; wagersOpen: boolean;
  queued: { stake: number; since: number; window: number } | null;
  incoming: { id: string; from: Brief; stake: number; expiresAt: number }[];
  outgoing: { id: string; to: Brief; stake: number; expiresAt: number }[];
  history: { matchId: string; opponentName: string; stake: number; result: 'win' | 'loss' | 'void'; ratingDelta: number; at: number }[];
  liveMatch: { id: string; stake: number; opponent: Brief; locking: { keys: boolean; mine: boolean; theirs: boolean; ready: { mine: boolean; theirs: boolean }; started: boolean } | null } | null;
  found?: Brief | null;
  /** Everyone this player found, challenged or played, online first. */
  friends?: (Brief & { playing: boolean; contact?: boolean })[];
  notice: string;
  walletWaiting?: string | null;
  team: {
    picked: string[]; chosen: string[]; poultice: number; tonic: number;
    creatures: { id: string; name: string; species: string; level: number; hp: number; maxHp: number; charges: { name: string; left: number; max: number }[] }[];
  };
}>();
const interact = inject<(id: string, event: string, data: unknown) => void>('rpgGuiInteraction')!;
const send = (action: string, data: Record<string, unknown> = {}) => interact('lobby', 'lobby', { action, ...data });

const tab = ref<'team' | 'play' | 'friends' | 'history'>('team');
/** Search, and put the keyboard away so the player card below it is in view. */
function find() { (document.activeElement as HTMLElement | null)?.blur(); send('find', { query: query.value }); }
const TEAM_SIZE = 3;
const slot = (id: string) => props.team.chosen.indexOf(id);
const pickedCreatures = computed(() => props.team.picked.map(id => props.team.creatures.find(c => c.id === id)!).filter(Boolean));
function toggle(id: string) {
  const chosen = props.team.chosen.filter(x => props.team.creatures.some(c => c.id === x));
  const next = chosen.includes(id) ? chosen.filter(x => x !== id) : chosen.length < TEAM_SIZE ? [...chosen, id] : chosen;
  send('set-team', { creatureIds: next });
}
const fullCharges = (c: { charges: { left: number; max: number }[] }) => c.charges.every(x => x.left >= x.max);
const hpPct = (c: { hp: number; maxHp: number }) => `${(c.hp / c.maxHp) * 100}%`;
const stake = ref(0);
const nameDraft = ref('');
const query = ref('');
const copied = ref(false);
const clock = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onUnmounted(() => clearInterval(timer));

const waited = computed(() => props.queued ? Math.max(0, Math.round((clock.value - props.queued.since) / 1000)) : 0);
const windowText = computed(() => !props.queued ? '' : Number.isFinite(props.queued.window) ? `±${props.queued.window} rating` : 'anyone at this stake');
const shortId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;
const open = (s: number) => s === 0 || props.wagersOpen;
const wild = (s: number) => (s === 0 ? 'FREE' : `${s.toLocaleString()} WILD`);
/** A friend challenge names any amount; the tiers are shortcuts. */
const friendStake = ref(0);
const friendStakeOk = computed(() => Number.isSafeInteger(friendStake.value) && friendStake.value >= 0 && friendStake.value <= props.maxStake && open(friendStake.value));
async function copyId() { await navigator.clipboard.writeText(props.me.id); copied.value = true; }
</script>

<template>
  <div class="lobby">
    <section class="panel">
      <header class="top">
        <div class="who">
          <b class="px">{{ me.name ? `@${me.name}` : 'PICK A NAME' }}</b>
          <small>Rating {{ me.rating }} · {{ me.wins }}W {{ me.losses }}L</small>
          <button class="idBtn" :title="me.id" @click="copyId">ID {{ shortId(me.id) }} · {{ copied ? 'copied' : 'copy' }}</button>
        </div>
        <button class="px close" @click="send('close')">✕</button>
      </header>

      <form v-if="!me.name" class="nameForm" @submit.prevent="send('set-name', { name: nameDraft })">
        <input v-model="nameDraft" maxlength="16" placeholder="username" autocapitalize="off" autocomplete="off" />
        <button class="px go">SAVE</button>
        <small>3–16 letters, digits or _. Friends find you by it; your DSM ID stays who you are.</small>
      </form>

      <nav class="tabs">
        <button v-for="t in (['team', 'play', 'friends', 'history'] as const)" :key="t" class="px" :class="{ on: tab === t }" @click="tab = t">{{ t === 'play' ? 'MATCH' : t.toUpperCase() }}<i v-if="t === 'friends' && incoming.length" class="badge">{{ incoming.length }}</i></button>
      </nav>

      <p v-if="notice" class="notice">{{ notice }}</p>
      <div v-if="walletWaiting" class="card walletWait"><b>Your DSM wallet is waiting for you</b><small>{{ walletWaiting }}</small><a class="px go wide" href="dsm:wallet">OPEN WALLET ▶</a></div>

      <!-- A staked match waits for both stakes to lock on DSM and both wallets to ready before the battle opens. -->
      <div v-if="liveMatch?.locking" class="card live locking">
        <b>Locking stakes · {{ wild(liveMatch.stake) }} each vs @{{ liveMatch.opponent.name }}</b>
        <small><i class="tick" :class="{ on: liveMatch.locking.keys }"></i>{{ liveMatch.locking.keys ? 'Both wallets named their battle keys' : 'Your wallets are naming their battle keys…' }}</small>
        <small><i class="tick" :class="{ on: liveMatch.locking.mine }"></i>Your stake {{ liveMatch.locking.mine ? 'locked for the match' : 'locking… your wallet checks both teams first; if it asks, approve it there' }}</small>
        <small><i class="tick" :class="{ on: liveMatch.locking.theirs }"></i>@{{ liveMatch.opponent.name }}'s stake {{ liveMatch.locking.theirs ? 'locked for the match' : liveMatch.locking.mine ? 'locking…' : 'locks after yours' }}</small>
        <small><i class="tick" :class="{ on: liveMatch.locking.ready.mine }"></i>{{ liveMatch.locking.ready.mine ? 'Your wallet is ready: it checked both stakes' : 'Your wallet readies once both stakes are in' }}</small>
        <small><i class="tick" :class="{ on: liveMatch.locking.started }"></i>{{ liveMatch.locking.started ? 'Both ready: the match has started' : `Waiting for @${liveMatch.opponent.name}'s wallet to ready` }}</small>
        <small class="fineprint">No referee: the program decides the match from both wallets' signed moves, and the winner's wallet collects both. If a wallet never readies, the other withdraws: the match is void and each stake goes back.</small>
      </div>
      <div v-else-if="liveMatch" class="card live">You're in a match vs @{{ liveMatch.opponent.name }}.</div>

      <template v-else-if="tab === 'team'">
        <div class="card">
          <b>Your team</b>
          <small>Pick up to three, in order: they fight one at a time, as you leave them. Heal and recharge them before you battle.</small>
          <small class="bag">Herb Poultice ×{{ team.poultice }} · Charge Tonic ×{{ team.tonic }}</small>
        </div>
        <div v-for="c in team.creatures" :key="c.id" class="card mon" :class="{ picked: slot(c.id) >= 0, down: c.hp === 0 }">
          <div class="monRow">
            <i class="thumb" :style="{ backgroundImage: `url(/creatures/${c.species}.png)` }"></i>
            <div class="grow">
              <b>{{ c.name }} <small>Lv {{ c.level }}</small></b>
              <div class="hp"><i :style="{ width: hpPct(c) }"></i></div>
              <small>{{ c.hp === 0 ? 'Fainted · heal before fielding' : `${c.hp}/${c.maxHp} HP` }}<template v-for="m in c.charges" :key="m.name"> · {{ m.name }} {{ m.left }}/{{ m.max }}</template></small>
            </div>
          </div>
          <div class="row">
            <button class="px pick" :class="{ on: slot(c.id) >= 0 }" :disabled="slot(c.id) < 0 && team.chosen.length >= 3" @click="toggle(c.id)">{{ slot(c.id) >= 0 ? `TEAM ${slot(c.id) + 1}` : 'ADD' }}</button>
            <button class="px" :disabled="!team.poultice || c.hp >= c.maxHp" @click="send('use-item', { item: 'poultice', creatureId: c.id })">HEAL</button>
            <button class="px" :disabled="!team.tonic || fullCharges(c)" @click="send('use-item', { item: 'tonic', creatureId: c.id })">CHARGE</button>
          </div>
        </div>
      </template>

      <template v-else-if="tab === 'play' || tab === 'friends'">
        <button class="card strip" @click="tab = 'team'"><small class="px lbl">TEAM</small><span v-for="c in pickedCreatures" :key="c.id" class="mini"><i class="thumb" :style="{ backgroundImage: `url(/creatures/${c.species}.png)` }"></i><small>{{ c.hp }}/{{ c.maxHp }}</small></span><small v-if="!pickedCreatures.length">None standing · heal first</small></button>
        <template v-if="tab === 'play'">
          <div class="card">
            <small class="px lbl">STAKE</small>
            <div class="stakes">
              <button v-for="s in stakes" :key="s" class="px stake" :class="{ on: stake === s }" :disabled="!open(s) || !!queued" @click="stake = s">{{ wild(s) }}</button>
            </div>
            <small class="hint">In a staked match each wallet locks its own stake, and a pinned program decides it, not the game.</small>
          </div>
          <div class="card">
            <template v-if="queued">
              <b class="big">Finding an opponent… {{ waited }}s</b>
              <small>{{ queued.stake === 0 ? 'Free match' : wild(queued.stake) }} · matching {{ windowText }}</small>
              <button class="px cancel" @click="send('leave-queue')">LEAVE QUEUE</button>
            </template>
            <template v-else>
              <b class="big">Ready to battle</b>
              <small>Your team (pick it in TEAM) fights as you left it; knock out all of theirs to win.</small>
              <button class="px go wide" :disabled="!open(stake)" @click="send('queue', { stake })">FIND A MATCH</button>
            </template>
          </div>
        </template>

        <template v-else>
          <div v-for="c in incoming" :key="c.id" class="card challenge">
            <b>@{{ c.from.name }} challenges you</b>
            <small>{{ shortId(c.from.id) }} · rating {{ c.from.rating }} · {{ c.stake === 0 ? 'free match' : `for ${wild(c.stake)}` }}</small>
            <div class="row"><button class="px go" @click="send('accept', { id: c.id })">ACCEPT</button><button class="px cancel" @click="send('decline', { id: c.id })">DECLINE</button></div>
          </div>
          <form class="card" @submit.prevent="find">
            <small class="px lbl">FIND A FRIEND</small>
            <div class="row"><input v-model="query" placeholder="username or DSM ID" autocapitalize="off" autocomplete="off" /><button class="px go">FIND</button></div>
          </form>
          <div class="card">
            <small class="px lbl">FRIENDS</small>
            <small v-if="!friends?.length">Players you find, challenge or play stay here.</small>
            <button v-for="f in friends" :key="f.id" type="button" class="friendrow" @click="send('find', { query: f.id })">
              <i class="dot" :class="{ on: f.online }"></i><b>@{{ f.name }}</b>
              <small>{{ f.contact ? 'contact · ' : '' }}{{ f.playing ? 'in a match' : f.online ? 'online' : 'offline' }} · {{ f.rating }}</small>
            </button>
          </div>
          <div v-if="found" class="card friend">
            <small class="px lbl">PLAYER FOUND</small>
            <div class="who"><i class="dot" :class="{ on: found.online }"></i><b>@{{ found.name }}</b><small>rating {{ found.rating }}</small></div>
            <small>{{ shortId(found.id) }} · {{ found.online ? 'online now' : 'offline: they need the game open to accept' }}</small>
            <small class="px lbl">STAKE · ANY AMOUNT</small>
            <div class="row"><input v-model.number="friendStake" type="number" min="0" :max="maxStake" step="1" inputmode="numeric" /><span>WILD</span></div>
            <div class="stakes"><button v-for="s in stakes" :key="s" type="button" class="px stake" :class="{ on: friendStake === s }" :disabled="!open(s)" @click="friendStake = s">{{ wild(s) }}</button></div>
            <button class="px go wide" :disabled="!found.online || !friendStakeOk" @click="send('challenge', { to: found.id, stake: friendStake })">CHALLENGE @{{ found.name.toUpperCase() }}{{ friendStake ? ` FOR ${friendStake.toLocaleString()} WILD` : '' }} ▶</button>
            <button v-if="friends?.some((f) => f.id === found!.id)" type="button" class="px cancel" @click="send('unfriend', { id: found!.id })">REMOVE FRIEND</button>
          </div>
          <div v-for="c in outgoing" :key="c.id" class="card">
            <small>Waiting for @{{ c.to.name }} to accept…</small>
            <button class="px cancel" @click="send('cancel', { id: c.id })">CANCEL</button>
          </div>
        </template>
      </template>

      <template v-else>
        <p v-if="!history.length" class="hint">No matches yet.</p>
        <div v-for="h in history" :key="h.matchId" class="card hist" :class="h.result">
          <b>{{ h.result === 'win' ? 'Won' : h.result === 'loss' ? 'Lost' : 'Void' }} vs @{{ h.opponentName }}</b>
          <small>{{ h.stake === 0 ? 'Free' : wild(h.stake) }} · rating {{ h.ratingDelta >= 0 ? '+' : '' }}{{ h.ratingDelta }}</small>
        </div>
      </template>
      <p class="fine">Matches run on the game server. Your rating and history belong to your DSM passport.</p>
    </section>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=VT323&display=swap');
.lobby{position:fixed;inset:0;z-index:60;pointer-events:auto;overflow-y:auto;background:#10251b url(/tiles/matchmaking-lobby-pixel-v3.png) center top/cover no-repeat;image-rendering:pixelated;color:#f6efd2;font-family:'VT323',ui-monospace,monospace;font-size:18px}
.px{font-family:'Silkscreen',monospace;letter-spacing:0}
.panel{margin:32vh auto 24px;width:min(440px,calc(100vw - 24px));display:grid;gap:10px}
button{font:inherit;cursor:pointer;border:0;color:#f3f3df;background:#1f4434;box-shadow:0 0 0 2px #0b1a15,inset 2px 2px 0 #ffffff22,inset -2px -3px 0 #00000055}
button:disabled{opacity:.4;cursor:default}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:10px 12px;background:#1b3a2ef2;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e,0 0 0 6px #0b1a15}
.who{display:grid;gap:2px}.who b{font-size:13px;color:#c4ec79}.who small{color:#cfe3cb}
.idBtn{justify-self:start;margin-top:4px;padding:3px 8px;font-size:15px;background:#10261f}
.close{padding:6px 10px;font-size:11px}
.nameForm{display:grid;grid-template-columns:1fr auto;gap:8px;padding:10px;background:#10261fef;box-shadow:0 0 0 2px #0b1a15}.nameForm small{grid-column:1/-1;color:#cfe3cb;font-size:15px}
input,select{font:inherit;font-size:19px;color:#26443a;background:#f6efd2;border:0;box-shadow:0 0 0 2px #26443a;padding:6px 10px;min-width:0}
.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.tabs button{position:relative;padding:9px 4px;font-size:9px;background:#1b3a2e}.tabs button.on{background:#e9d86b;color:#26443a}
.badge{position:absolute;top:-6px;right:-4px;background:#dc6a4e;color:#fff;font-style:normal;font-size:9px;padding:2px 6px;border-radius:9px}
.card{display:grid;gap:6px;padding:12px;background:#10261fef;box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #26443a}
.card small{color:#cfe3cb;font-size:16px}.lbl{font-size:9px;color:#c4ec79}
.big{font-size:22px}
.stakes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.stake{padding:8px 2px;font-size:9px}.stake.on{background:#e9d86b;color:#26443a}
.hint{color:#b9cdb6;font-size:15px;margin:0}
.locking small{display:flex;align-items:center;gap:8px}.locking .fineprint{opacity:.75;font-size:15px}
.tick{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid #9ccf6e;animation:pulse 1s ease-in-out infinite}.tick.on{background:#9ccf6e;animation:none}
@keyframes pulse{50%{opacity:.3}}
.go{background:#3f6e2a;padding:8px 12px;font-size:10px}
.walletWait{box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #e2c35a}.walletWait a{text-align:center;text-decoration:none;color:#f6efd2}.go.wide{padding:12px;font-size:11px}
/* A found player reads as a player card, with the challenge as its button. */
.friend{box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #9ccf6e}.friend .who{display:flex;align-items:baseline;gap:8px}.friend .who b{font-size:30px;line-height:1}
.dot{width:10px;height:10px;border-radius:50%;background:#6b6b5e;align-self:center;flex:none}.dot.on{background:#9ccf6e;box-shadow:0 0 6px #9ccf6e}
.friendrow{display:flex;align-items:center;gap:8px;width:100%;padding:6px 2px;background:none;border:0;border-top:1px solid #1d3a2c;color:inherit;text-align:left;font:inherit}.friendrow b{color:#c4ec79}.friendrow small{margin-left:auto;color:#cfe3cb}
.cancel{background:#7a3b1e;padding:8px 12px;font-size:10px;justify-self:start}
.row{display:flex;gap:8px;align-items:center}.row input{flex:1}
.notice{margin:0;padding:8px 10px;background:#e9dcb4;color:#2b1a10;box-shadow:0 0 0 2px #2b1a10}
.live{text-align:center}
.hist.win b{color:#c4ec79}.hist.loss b{color:#f0a58e}
.fine{margin:4px 0 0;text-align:center;color:#d7e6cf;font-size:14px;text-shadow:0 1px 0 #000}
.bag{color:#e9d86b!important}
.mon{gap:8px}.monRow{display:flex;gap:10px;align-items:center}.grow{flex:1;min-width:0;display:grid;gap:3px}.grow b small{color:#b9cdb6;font-size:15px}
.thumb{width:48px;height:48px;flex:none;background:center/contain no-repeat;image-rendering:pixelated;display:block}
.hp{height:8px;background:#3b3f2e;box-shadow:0 0 0 2px #26443a}.hp i{display:block;height:100%;background:#4da96c}
.mon.down .hp i{background:#7a3b1e}.mon.picked{box-shadow:0 0 0 2px #0b1a15,0 0 0 4px #e9d86b}
.mon .row button{padding:7px 8px;font-size:9px;flex:1}.pick.on{background:#e9d86b;color:#26443a}
.strip{display:flex;align-items:center;gap:8px;text-align:left;font:inherit;color:#f6efd2;background:#10261fef}.mini{display:grid;justify-items:center}.mini .thumb{width:36px;height:36px}.mini small{font-size:13px}
</style>
