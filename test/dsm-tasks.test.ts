import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b32 } from '../src/integrations/dsm/host';
import { initialState, transition, type Command, type GameState } from '../src/domain/game';
import type { PanelData } from '../src/modules/main/dsm';

// Adapter tests of the game server's DSM tasks; the account is a fixture and establishes nothing.
// Each host call answers after a delay, so two connections' tasks interleave as they do live.
const fixture = vi.hoisted(() => ({
  /** Objects the game account holds, by anchor (Base32), with their tickers. */
  held: new Map<string, { ticker: string; amount: bigint }>(),
  created: [] as string[],
  /** Every `wallet.sendSmart`: ticker, amount, recipient (Base32), and whether it went. */
  sends: [] as { ticker: string; amount: string; to: string; sent: boolean }[],
  requests: new Map<bigint, { case: string; value?: { policyCommit?: Uint8Array; amount?: bigint } }>(),
  seq: 0n,
  sessions: [] as { sessionId: Uint8Array; peerDeviceId: Uint8Array; status?: number }[],
  /** How long the wallet takes to answer an accept, and the account to create a token, in ms. */
  acceptAfter: 5,
  createAfter: 5,
  /** WILD transfers the account refuses before it sends again (it was restarting, say). */
  refuseWild: 0,
  /** How long the wallet takes to pay, in ms (a payment past the grant waits for the player's approval). */
  payAfter: 5,
  /** Every price the account was asked for, as entered. */
  routes: [] as string[],
}));
const later = <T>(value: () => T, ms = 5) => new Promise<T>((resolve, reject) => setTimeout(() => { try { resolve(value()); } catch (e) { reject(e); } }, ms));
const bytes32 = (text: string) => new Uint8Array(createHash('sha256').update(text).digest());

vi.mock('../src/integrations/dsm/host', async (original) => {
  const real = await original<typeof import('../src/integrations/dsm/host')>();
  const { b32: base32, HostError: Refusal } = real;
  class FixtureHost {
    constructor(readonly base: string) {}
    activity = async () => ({ deviceId: new Uint8Array(32).fill(1), storageSetId: new Uint8Array(32), signatureBytes: 0, entries: [] });
    balances = () => later(() => [
      { tokenId: 'ERA', policyAnchorB32: base32(new Uint8Array(32).fill(3)), available: 1_000_000n },
      ...[...fixture.held].map(([anchor, h]) => ({ tokenId: h.ticker, policyAnchorB32: anchor, available: h.amount })),
    ]);
    sessions = () => later(() => fixture.sessions.map((s) => ({ ...s, offerDigest: new Uint8Array(), status: s.status ?? 1, granted: [], lastSeq: 0n, peerGenesis: new Uint8Array(32) })));
    createToken = (p: { ticker: string; alias: string; supply: bigint; description: string }) => later(() => {
      fixture.created.push(p.ticker);
      const anchor = new Uint8Array(createHash('sha256').update(`${p.ticker}|${p.alias}|${p.supply}|${p.description}`).digest());
      fixture.held.set(base32(anchor), { ticker: p.ticker, amount: p.supply });
      return anchor;
    }, fixture.createAfter);
    // An object the account no longer holds is refused as a transfer still settling, which the game
    // retries: the once-a-second `wallet.sendSmart` loop seen live.
    send = (to: Uint8Array, ticker: string, amount: string) => later(() => {
      const object = [...fixture.held.values()].find((h) => h.ticker === ticker);
      if (ticker === 'WILD' && fixture.refuseWild > 0) {
        fixture.refuseWild -= 1;
        fixture.sends.push({ ticker, amount, to: base32(to), sent: false });
        throw new Refusal('wallet.sendSmart: the account is restarting');
      }
      const sent = ticker === 'WILD' || (object !== undefined && object.amount >= BigInt(amount));
      fixture.sends.push({ ticker, amount, to: base32(to), sent });
      if (!sent) throw new Refusal('wallet.sendSmart: pending online transition');
      if (object) object.amount -= BigInt(amount);
    });
    sync = () => later(() => ({}));
    // A fresh connect offer (a page whose session is gone shows a new code).
    offer = () => later(() => { fixture.seq += 1n; const d = bytes32(`offer ${fixture.seq}`); return { offerDigest: d, code: `CODE-${fixture.seq}` }; });
    offerOf = (digest: Uint8Array) => later(() => ({ offerDigest: digest, code: 'CODE-AGAIN' }));
    request = (_session: Uint8Array, kind: { case: string; value?: { policyCommit?: Uint8Array; amount?: bigint } }) =>
      later(() => { fixture.seq += 1n; fixture.requests.set(fixture.seq, kind); return fixture.seq; });
    // The wallet carries out what it accepts, and a payment reaches the account once; a holdings
    // proof is not part of these fixtures.
    status = (_session: Uint8Array, seq: bigint) => later(() => {
      const kind = fixture.requests.get(seq)!;
      if (kind.case === 'acceptIssued') return { answered: true, outcome: 1, fact: 1, reason: '' };
      if (kind.case === 'pay') {
        const object = fixture.held.get(base32(kind.value!.policyCommit!));
        if (object && !(kind as { paid?: boolean }).paid) object.amount += kind.value!.amount!;
        (kind as { paid?: boolean }).paid = true;
        return { answered: true, outcome: 1, fact: 2, reason: '', paidTx: new TextEncoder().encode(`tx ${seq}`) };
      }
      return { answered: true, outcome: 3, fact: 1, reason: 'not part of this fixture', factDetail: 'not part of this fixture' };
    }, { acceptIssued: fixture.acceptAfter, pay: fixture.payAfter }[fixture.requests.get(seq)?.case ?? ''] ?? 5);
    // The market's price, as the account finds it over the vaults' public state.
    findRoute = (_in: Uint8Array, _out: Uint8Array, entered: string) => later(() => {
      fixture.routes.push(entered);
      return { hops: [{}], search: 1, amountIn: 1000n, amountOut: 97n };
    });
    vaults = () => later(() => []);
    readAuthored = () => later(() => ({ complete: true, objects: [] }));
    publishAuthored = () => later(() => ({ stored: true }));
  }
  return { ...real, DsmHost: FixtureHost };
});

// The game's record, on disk where the game server keeps it; read when the world is first set up.
const record = join(mkdtempSync(join(tmpdir(), 'dsm-tasks-')), 'record.json');
process.env.DSM_APP_HOST = 'http://fixture.invalid';
process.env.DSM_GAME_RECORD = record;
writeFileSync(record, JSON.stringify({
  account: b32(new Uint8Array(32).fill(1)), wild: b32(new Uint8Array(32).fill(2)), vault: null,
  market: { plan: null, legacyClosed: true, lanes: [4, 5, 6, 7, 8].map((i) => b32(new Uint8Array(32).fill(i))) },
  creatures: {}, nextSerial: 1,
  profiles: {}, stats: {}, inFlight: {}, resume: {}, welcomed: [], players: {}, usernames: {}, matches: {},
}));
const dsm = await import('../src/modules/main/dsm');

// The game state, as the field module keeps it: one save per player object, changed by the reducer.
const states = new Map<object, GameState>();
dsm.useReadState((p) => states.get(p)!);
dsm.useCommit((p, command: Command) => {
  const s = states.get(p)!;
  const next = transition(s, s.revision, `${s.holder}/command/${s.revision}`, command);
  states.set(p, next);
  return next;
});

/** A page of the game: a player object whose screens accept anything. */
type Page = Parameters<typeof dsm.connectWallet>[0];
function page(id: string): Page {
  const gui = {
    on: (event: string, f: (d: { token?: string }) => void) => { if (event === 'resume') f({ token: tokenOf.get(id) }); handlers.set(`${id} ${event}`, f); },
    open: async () => {}, update: (d: unknown) => { screens.set(id, d); }, close: () => {},
  };
  const panel = { update: (data: PanelData) => { panels.set(id, data); } };
  return { id, gui: () => gui, getGui: (name: string) => (name === 'dsm-panel' ? panel : undefined) } as unknown as Page;
}
const panels = new Map<string, PanelData>();
/** What each page's open screen shows last, by page id. */
const screens = new Map<string, unknown>();
/** What each page's screens do on an event, by page id and event. */
const handlers = new Map<string, (d: Record<string, unknown>) => void>();
/** What a page's DSM panel says went wrong (holdings proofs are not part of these fixtures). */
const failures = (p: Page) => (panels.get(p.id)?.entries ?? [])
  .filter((e) => e.tone === 'fail' && !e.title.startsWith('Proving your holdings')).map((e) => `${e.title}: ${e.detail}`);
const tokenOf = new Map<string, string>();

let n = 0;
/** A wallet with an approved session and the game profile `profile` makes of it; each page of it resumes that login. */
async function wallet(profile: (holder: string) => GameState, welcomed = false) {
  const w = await dsm.world();
  const device = bytes32(`wallet ${++n}`);
  const holder = b32(device);
  const sessionId = bytes32(`session ${n}`);
  fixture.sessions.push({ sessionId, peerDeviceId: device });
  const token = `token-${n}`;
  w.economy.record.resume[token] = { offer: 'OFFER', session: b32(sessionId) };
  w.economy.record.profiles[holder] = profile(holder);
  if (welcomed) w.economy.record.welcomed.push(holder);
  /** A page connects (`again`: the same page connects once more, as one whose session was not picked up does). */
  const connect = (id: string, again?: Page) => {
    tokenOf.set(id, token);
    const p = again ?? page(id);
    return dsm.connectWallet(p, (state) => states.set(p, state)).then(() => p);
  };
  return { holder, connect, w };
}
const idle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
/** A profile whose starter was issued and delivered long ago (its object is not this account's). */
const settled = (holder: string) => ({ ...initialState(holder), creatures: [{ ...initialState(holder).creatures[0], anchor: b32(bytes32(`starter ${holder}`)) }] });

beforeEach(() => { fixture.created.length = 0; fixture.sends.length = 0; });

describe('the starting coin', () => {
  it('is paid once to a wallet that connects twice before the first payment is through', async () => {
    const { holder, connect, w } = await wallet(settled);
    await Promise.all([connect(`${holder}/page-1`), connect(`${holder}/page-2`)]);
    await idle();
    expect(fixture.sends.filter((s) => s.to === holder && s.ticker === 'WILD')).toEqual([{ ticker: 'WILD', amount: '10', to: holder, sent: true }]);
    expect(w.economy.record.welcomed.filter((x) => x === holder)).toHaveLength(1);
  });
});

/** A profile with a creature caught and not yet issued: its delivery was queued when the page went away. */
const caught = (holder: string) => {
  const s = settled(holder);
  return { ...s, creatures: [...s.creatures, { ...initialState(holder).creatures[0], id: `${holder}/wild/0/creature`, species: 'mossling' as const }] };
};
const creatureSends = (holder: string) => fixture.sends.filter((s) => s.to === holder && s.ticker !== 'WILD');

describe('delivering a caught creature', () => {
  it('issues it once when the same page connects again before its delivery ran', async () => {
    const { holder, connect, w } = await wallet(caught, true);
    const p = page(`${holder}/page`);
    await Promise.all([connect(p.id, p), connect(p.id, p)]);
    await idle();
    expect(fixture.created).toHaveLength(1);
    const anchor = states.get(p)!.creatures[1].anchor;
    expect(anchor).not.toBeNull();
    expect(Object.keys(w.economy.record.creatures)).toContain(anchor);
    expect(creatureSends(holder)).toEqual([{ ticker: fixture.created[0], amount: '1', to: holder, sent: true }]);
    expect(failures(p)).toEqual([]);
  });

  it('issues it once when two pages of one wallet connect, and both pages know it by its one object', async () => {
    const { holder, connect } = await wallet(caught, true);
    const [one, two] = await Promise.all([connect(`${holder}/page-1`), connect(`${holder}/page-2`)]);
    await idle();
    expect(fixture.created).toHaveLength(1);
    expect(creatureSends(holder).filter((s) => s.sent)).toHaveLength(1);
    const anchor = states.get(one)!.creatures[1].anchor;
    expect(anchor).not.toBeNull();
    expect(states.get(two)!.creatures[1].anchor).toBe(anchor);
  });
});

describe('handing over an issued creature', () => {
  /** A profile bound to an object the account issued and still holds: a restart cut its delivery off. */
  const cutOff = (holder: string) => {
    const s = settled(holder);
    const anchor = b32(bytes32(`cut off ${holder}`));
    fixture.held.set(anchor, { ticker: `MS${holder.slice(0, 4)}`, amount: 1n });
    return { ...s, creatures: [...s.creatures, { ...initialState(holder).creatures[0], id: `${holder}/wild/0/creature`, species: 'mossling' as const, anchor }] };
  };

  it('sends it once when two connections both resume its delivery, and the second stops saying why instead of retrying', async () => {
    const { holder, connect, w } = await wallet(cutOff, true);
    const anchor = w.economy.record.profiles[holder].creatures[1].anchor!;
    w.economy.record.creatures[anchor] = { species: 'mossling', serial: 9001, ticker: `MS${holder.slice(0, 4)}` };
    const [one, two] = await Promise.all([connect(`${holder}/page-1`), connect(`${holder}/page-2`)]);
    await idle(1500);
    expect(creatureSends(holder)).toEqual([{ ticker: `MS${holder.slice(0, 4)}`, amount: '1', to: holder, sent: true }]);
    expect(fixture.held.get(anchor)!.amount).toBe(0n);
    expect([...failures(one), ...failures(two)].join('\n')).toMatch(/no longer holds/);
  });

  it('sends it to one wallet when two players\' profiles are bound to it (the record a duplicate issuance left), and tells the other why', async () => {
    const anchor = b32(bytes32('one object, two profiles'));
    fixture.held.set(anchor, { ticker: 'EM0027', amount: 1n });
    const both = (holder: string) => ({ ...settled(holder), creatures: [{ ...settled(holder).creatures[0], anchor }] });
    const first = await wallet(both, true);
    const second = await wallet(both, true);
    first.w.economy.record.creatures[anchor] = { species: 'embercub', serial: 27, ticker: 'EM0027' };
    const [one, two] = await Promise.all([first.connect(`${first.holder}/page`), second.connect(`${second.holder}/page`)]);
    await idle(1500);
    expect(fixture.sends.filter((s) => s.ticker === 'EM0027')).toHaveLength(1);
    expect(fixture.held.get(anchor)!.amount).toBe(0n);
    expect([...failures(one), ...failures(two)].join('\n')).toMatch(/already being handed over|no longer holds/);
  });
});

describe('a creature sold to Bramble', () => {
  it('is never handed back to the wallet that sold it, whatever an older page of that wallet still shows', async () => {
    const anchor = b32(bytes32('sold to Bramble'));
    const ticker = 'MS4242';
    const party = (holder: string) => ({ ...settled(holder), creatures: [...settled(holder).creatures, { ...initialState(holder).creatures[0], id: `${holder}/wild/0/creature`, species: 'mossling' as const, anchor }] });
    const { holder, connect, w } = await wallet(party, true);
    // Delivered long ago: the wallet holds it, the account does not.
    w.economy.record.creatures[anchor] = { species: 'mossling', serial: 4242, ticker };
    fixture.held.set(anchor, { ticker, amount: 0n });
    const [selling, older] = await Promise.all([connect(`${holder}/page-1`), connect(`${holder}/page-2`)]);
    await idle();
    await dsm.openShop(selling);
    handlers.get(`${selling.id} shop`)!({ action: 'sell', creatureId: `${holder}/wild/0/creature` });
    await idle();
    expect(fixture.held.get(anchor)!.amount).toBe(1n);
    expect(states.get(selling)!.creatures.map((c) => c.anchor)).not.toContain(anchor);
    // The older page plays on, and its state goes into the game's record as every command's does.
    dsm.persist(older, states.get(older)!);
    await idle(50);
    await connect(`${holder}/page-3`);
    await idle();
    expect(fixture.sends.filter((s) => s.ticker === ticker)).toEqual([]);
    expect(fixture.held.get(anchor)!.amount).toBe(1n);
  });
});

describe('a page that goes away mid-delivery', () => {
  it('comes back to the object issued for its creature, delivered, not a second one', async () => {
    const { holder, connect, w } = await wallet(caught, true);
    fixture.createAfter = 60;
    const gone = await connect(`${holder}/page-1`);
    // The page goes while the account creates the creature's token.
    await new Promise((r) => setTimeout(r, 20));
    dsm.leave(gone);
    await idle();
    fixture.createAfter = 5;
    const back = await connect(`${holder}/page-2`);
    await idle();
    expect(fixture.created).toHaveLength(1);
    const anchor = Object.keys(w.economy.record.creatures).find((a) => w.economy.record.creatures[a].creature === `${holder}/wild/0/creature`);
    expect(anchor).toBeDefined();
    expect(states.get(back)!.creatures[1].anchor).toBe(anchor);
    expect(creatureSends(holder)).toEqual([{ ticker: fixture.created[0], amount: '1', to: holder, sent: true }]);
  });

  it('delivers and pays what one wallet was owed to that wallet, not to another the same page connected next', async () => {
    const first = await wallet((holder) => {
      const s = settled(holder);
      const anchor = b32(bytes32(`cut off for ${holder}`));
      fixture.held.set(anchor, { ticker: 'TF0777', amount: 1n });
      return { ...s, creatures: [...s.creatures, { ...initialState(holder).creatures[0], id: `${holder}/wild/0/creature`, species: 'tidefin' as const, anchor }] };
    });
    const anchor = first.w.economy.record.profiles[first.holder].creatures[1].anchor!;
    first.w.economy.record.creatures[anchor] = { species: 'tidefin', serial: 777, ticker: 'TF0777' };
    const second = await wallet(settled, true);
    // The page resumes the first wallet's delivery (its starting coin queued behind it); the wallet takes its time accepting.
    fixture.acceptAfter = 150;
    const p = await first.connect('shared-page');
    await new Promise((r) => setTimeout(r, 40));
    // Its session gone, the same page connects another wallet before that delivery is through.
    await second.connect(p.id, p);
    await idle();
    fixture.acceptAfter = 5;
    expect(fixture.sends.filter((s) => s.to === second.holder)).toEqual([]);
    expect(fixture.sends.filter((s) => s.to === first.holder).sort((x, y) => x.ticker.localeCompare(y.ticker))).toEqual([
      { ticker: 'TF0777', amount: '1', to: first.holder, sent: true },
      { ticker: 'WILD', amount: '10', to: first.holder, sent: true },
    ]);
    expect(first.w.economy.record.inFlight[first.holder]).toEqual([anchor]);
  });
});

describe('WILD the game owes a wallet', () => {
  const paid = (holder: string) => fixture.sends.filter((s) => s.to === holder && s.ticker === 'WILD' && s.sent).map((s) => s.amount);

  it('pays for a creature Bramble bought when the payment failed, once the wallet is back, and only once', async () => {
    const anchor = b32(bytes32('sold, then the payment failed'));
    const party = (holder: string) => ({ ...settled(holder), creatures: [...settled(holder).creatures, { ...initialState(holder).creatures[0], id: `${holder}/wild/0/creature`, species: 'mossling' as const, anchor }] });
    const { holder, connect, w } = await wallet(party, true);
    w.economy.record.creatures[anchor] = { species: 'mossling', serial: 5150, ticker: 'MS5150' };
    fixture.held.set(anchor, { ticker: 'MS5150', amount: 0n });
    const selling = await connect(`${holder}/page-1`);
    await idle();
    fixture.refuseWild = 1;
    await dsm.openShop(selling);
    handlers.get(`${selling.id} shop`)!({ action: 'sell', creatureId: `${holder}/wild/0/creature` });
    await idle();
    // Bramble has the creature; its price did not go.
    expect(fixture.held.get(anchor)!.amount).toBe(1n);
    expect(paid(holder)).toEqual([]);
    await Promise.all([connect(`${holder}/page-2`), connect(`${holder}/page-3`)]);
    await idle();
    expect(paid(holder)).toEqual(['8']);
  });

  it('pays a victory\'s reward whose transfer failed once the wallet is back, and only once', async () => {
    const { holder, connect } = await wallet(settled, true);
    const p = await connect(`${holder}/page-1`);
    await idle();
    const before = states.get(p)!;
    const fight = { id: `${holder}/wild/0`, creatureId: before.creatures[0].id, wild: { ...before.creatures[0], id: `${holder}/wild/0/creature` }, turn: 1, source: 'meadow' as const, log: [], format: 'single' as const, roster: [], bench: [], ko: { own: 0, foe: 0 }, events: [] };
    fixture.refuseWild = 1;
    dsm.onCommitted(p, { type: 'move', move: 'strike' }, { ...before, battle: { ...fight, outcome: 'active' } }, { ...before, battle: { ...fight, outcome: 'victory' } });
    await idle();
    expect(paid(holder)).toEqual([]);
    await connect(`${holder}/page-2`);
    await idle();
    expect(paid(holder)).toEqual(['5']);
  });
});

describe('Bramble\'s board', () => {
  const party = (anchor: string) => (holder: string) => ({ ...settled(holder), creatures: [...settled(holder).creatures, { ...initialState(holder).creatures[0], id: `${holder}/wild/0/creature`, species: 'mossling' as const, anchor }] });
  const payments = () => [...fixture.requests.values()].filter((k) => k.case === 'pay').length;

  it('refuses to take the lead before the wallet hands it over, not after', async () => {
    const anchor = b32(bytes32('the lead, offered'));
    const { holder, connect } = await wallet(party(anchor), true);
    const p = await connect(`${holder}/page`);
    await idle();
    const asked = payments();
    await dsm.openShop(p);
    handlers.get(`${p.id} shop`)!({ action: 'sell', creatureId: `${holder}/starter` });
    await idle();
    expect(payments()).toBe(asked);
    expect(failures(p).join('\n')).toMatch(/not-for-sale/);
  });

  it('refuses the Ranger\'s Map, not sold for now, before the wallet pays for it, however much it holds', async () => {
    const { holder, connect } = await wallet((h) => settled(h), true);
    const p = await connect(`${holder}/page`);
    await idle();
    const asked = payments();
    await dsm.openShop(p);
    handlers.get(`${p.id} shop`)!({ action: 'buy', item: 'map', qty: 1 });
    await idle();
    expect(payments()).toBe(asked);
    expect(failures(p).join('\n')).toMatch(/unavailable/);
  });

  it('pays for a creature it took even when the game state refuses the sale while the player was approving it', async () => {
    const anchor = b32(bytes32('made the lead while it was being sold'));
    const { holder, connect, w } = await wallet(party(anchor), true);
    w.economy.record.creatures[anchor] = { species: 'mossling', serial: 6060, ticker: 'MS6060' };
    fixture.held.set(anchor, { ticker: 'MS6060', amount: 0n });
    const p = await connect(`${holder}/page-1`);
    await idle();
    fixture.payAfter = 150;
    await dsm.openShop(p);
    handlers.get(`${p.id} shop`)!({ action: 'sell', creatureId: `${holder}/wild/0/creature` });
    await idle(60);
    // While the wallet waits on the player, the creature becomes the lead.
    const s = states.get(p)!;
    states.set(p, transition(s, s.revision, `${s.holder}/command/${s.revision}`, { type: 'set-lead', creatureId: `${holder}/wild/0/creature` }));
    await idle();
    fixture.payAfter = 5;
    expect(fixture.held.get(anchor)!.amount).toBe(1n);
    await connect(`${holder}/page-2`);
    await idle();
    expect(fixture.sends.filter((x) => x.to === holder && x.ticker === 'WILD' && x.sent).map((x) => x.amount)).toEqual(['8']);
  });

  it('prices a swap from the game account at once, asking the wallet nothing', async () => {
    const { holder, connect, w } = await wallet(settled, true);
    const p = await connect(`${holder}/page`);
    await idle();
    await w.economy.era();
    const asked = fixture.requests.size;
    await dsm.openMarket(p);
    handlers.get(`${p.id} market`)!({ action: 'quote', side: 'buy', amount: '10' });
    await idle(60);
    expect(fixture.requests.size).toBe(asked);
    expect(fixture.routes).toEqual(['10.00']);
    expect(screens.get(p.id)).toMatchObject({ quote: { side: 'buy', amountIn: '10.00 ERA', amountOut: '97 WILD', hops: 1 }, busy: null });
  });

  describe('a wallet that ends its session with the game', () => {
    it('sends that page back to the connect screen, once, and leaves other wallets playing', async () => {
      const a = await wallet(settled, true), b = await wallet(settled, true);
      const pa = await a.connect('page-gone'), pb = await b.connect('page-stays');
      let kickedA = 0, kickedB = 0;
      dsm.watchWallet(pa, () => { kickedA++; });
      dsm.watchWallet(pb, () => { kickedB++; });
      await dsm.checkSessions();
      expect([kickedA, kickedB, dsm.walletConnected(pa), dsm.walletConnected(pb)]).toEqual([0, 0, true, true]);
      // The wallet disconnects the game from its own side: the account reports the session DISCONNECTED.
      fixture.sessions.find((s) => b32(s.peerDeviceId) === a.holder)!.status = 2;
      await dsm.checkSessions();
      expect([kickedA, kickedB, dsm.walletConnected(pa), dsm.walletConnected(pb)]).toEqual([1, 0, false, true]);
      await dsm.checkSessions();
      expect(kickedA).toBe(1);
      expect((panels.get(pa.id)?.entries ?? []).some((e) => e.title === 'Wallet disconnected')).toBe(true);
    });

    it('tells a page that was away when its wallet disconnected (the phone was in the wallet app)', async () => {
      const w = await wallet(settled, true);
      const p = await w.connect('page-away');
      // The page goes to the background: its socket drops and its session is no longer checked.
      dsm.leave(p);
      fixture.sessions.find((s) => b32(s.peerDeviceId) === w.holder)!.status = 2;
      await dsm.checkSessions();
      const back = page('page-away');
      expect(await dsm.resumeWallet(back, w.holder)).toBe('disconnected');
      expect(dsm.walletConnected(back)).toBe(false);
      const titles = (panels.get(back.id)?.entries ?? []).map((e) => e.title);
      expect(titles).toContain('Profile loaded'); // the history it had before going away
      expect(titles.at(-1)).toBe('Wallet disconnected');
    });

    it('does not call a session the wallet still holds disconnected, when the page cannot pick it up', async () => {
      // The fixture's sessions carry no grant for the game's current offer, so none resumes.
      const w = await wallet(settled, true);
      const p = await w.connect('page-stale');
      dsm.leave(p);
      const back = page('page-stale');
      expect(await dsm.resumeWallet(back, w.holder)).toBe('none');
      expect((panels.get(back.id)?.entries ?? []).map((e) => e.title)).not.toContain('Wallet disconnected');
    });

    it('does not resume a disconnected session when the page connects again: it shows a fresh code', async () => {
      const w = await wallet(settled, true);
      const p = await w.connect('page-dead');
      const dead = fixture.sessions.find((s) => b32(s.peerDeviceId) === w.holder)!;
      dead.status = 2;
      dsm.watchWallet(p, () => {});
      await dsm.checkSessions();
      // The page connects again with the login it had: the dead session is not picked up, a new offer is shown.
      const again = w.connect('page-dead', p);
      await idle(2600);
      const shown = screens.get(p.id) as { code?: string; status?: string } | undefined;
      expect(dsm.walletConnected(p)).toBe(false);
      expect(shown?.status ?? '').toContain('Scan this');
      expect(await Promise.race([again.then(() => 'connected'), idle(300).then(() => 'still waiting')])).toBe('still waiting');
    });
  });
});
