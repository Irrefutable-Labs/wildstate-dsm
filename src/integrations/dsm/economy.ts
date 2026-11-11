/**
 * The game's economy on DSM (DSM Amendment A11, the §78 picture): the game
 * stays a Web2 game, plugged into DSM, and what a player owns is an object in
 * the player's wallet.
 *
 * - WILD, the game's coin: an object the game's account issued; its whole
 *   supply is the account's, and the account gives players WILD from it.
 * - The WILD/ERA market: MARKET_VAULTS SoFi vaults the account funds in equal slices, so
 *   players' trades through different vaults never race for one vault's key.
 * - Each creature an object of supply one, which the account issues when the
 *   creature is caught. Its committed policy names the game as issuer, the
 *   species and the capture; its policy commitment is the creature's
 *   identity. HP and XP stay game data, keyed by that identity.
 *
 * This file is the game's own Web2 record of what it did on DSM (which
 * anchors are its coin and its creatures, its players' game profiles). It is
 * never evidence of ownership: what a wallet owns comes from proofs the
 * account verifies.
 */
import type { Directory } from '../../domain/username';
import type { Match } from '../../domain/match';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SPECIES, type Creature, type GameState } from '../../domain/game';
import { SPECIES_IDS, birthCreatureState, creatureRecord, creatureRecordDigest, latestCreatureState } from '../../domain/program';
import { DsmHost, b32, fromB32, type Bytes } from './host';
import { COIN, MARKET, MARKET_VAULTS, entered } from './terms';
import * as pb from './proto/dsm_app_pb';

export type Species = Creature['species'];

/** The game's record of one creature it issued. */
interface IssuedCreature {
  species: Species;
  serial: number;
  ticker: string;
  /** The game creature (its id) the object was issued for; absent in records kept before it was. */
  creature?: string;
}

/** What a browser's resume token names: the offer it was shown, and the connection the wallet made of it. */
export interface Login {
  offer: string;
  session: string | null;
}

interface EconomyRecord {
  /** The game's account (Base32 device id). */
  account: string;
  /** WILD's policy anchor (Base32). */
  wild: string | null;
  /** The single WILD/ERA vault the market ran on before it was divided into lanes (Base32). */
  vault: string | null;
  /** The market's lanes, and how far dividing it has come. */
  market?: MarketRecord;
  creatures: Record<string, IssuedCreature>;
  nextSerial: number;
  /** Each player's game profile, by their wallet's account (Base32). */
  profiles: Record<string, GameState>;
  /** Game data of creatures that left a profile with their object, by anchor. */
  stats: Record<string, Creature>;
  /** Creature objects sent to each wallet that no proof of what it owns has shown yet, by wallet. */
  inFlight: Record<string, string[]>;
  /**
   * A browser's resume token → the offer it was shown and the connection that offer
   * became (Base32). Web2 only, never DSM authority: a page that comes back
   * (from the wallet app, or a reload) picks up its connection with it.
   */
  resume: Record<string, Login>;
  /** Wallets the starting coin was paid to. */
  welcomed: string[];
  /**
   * WILD the game owes each wallet (a creature's price, a victory's reward), by wallet: recorded
   * before it is sent and cleared once sent, so a transfer that failed is sent when the wallet is back.
   */
  owed: Record<string, { amount: string; why: string }[]>;
  /** Lobby profiles (username, rating, history), keyed by the wallet's DSM identity. Game data. */
  players: Directory['players'];
  /** Username index into `players`: a human-friendly label bound to an identity. */
  usernames: Directory['usernames'];
  /** Player-vs-player matches by id: run by the game server (Web2), kept across restarts. */
  matches: Record<string, Match>;
}

/**
 * The market divided into lanes (owner direction 2026-10-07). Each step that cannot be undone is
 * written here before the next begins, so a restart resumes where it stopped and never repeats one.
 */
interface MarketRecord {
  /** Each lane's WILD (whole coins) and ERA (hundredths): exact slices summing to what the market holds. */
  plan: { wild: string[]; era: string[] } | null;
  /** The single vault before lanes is closed (or there never was one). */
  legacyClosed: boolean;
  /** Each lane's vault (Base32), by lane index; null until opened. */
  lanes: (string | null)[];
}

/**
 * `total` in `parts` exact slices: each `⌊total/parts⌋`, the first `total mod parts` one more.
 * They sum to `total` exactly, to the smallest unit; nothing is dropped.
 */
export function splitExact(total: bigint, parts: number): bigint[] {
  const n = BigInt(parts);
  const each = total / n;
  const rest = total % n;
  return Array.from({ length: parts }, (_, i) => each + (BigInt(i) < rest ? 1n : 0n));
}

/** ERA's decimals. */
const ERA_DECIMALS = 2;

/** The fee issuing an object burns, in hundredths of an ERA (`TOKEN_CREATION_FEE_ERA`): 10 ERA. */
const CREATION_FEE_ERA = 1_000n;
/** ERA the account keeps before it creates anything: the coin, the market, a few creatures. */
// Fund the market and retain 200 ERA for issuing creatures, after WILD's creation fee.
const ERA_TO_START = BigInt(MARKET.era) * 100n + CREATION_FEE_ERA + 20_000n;

const CODE: Record<Species, string> = { embercub: 'EM', mossling: 'MS', tidefin: 'TF', voltusk: 'VT', leon: 'LN', rattlefin: 'RF', brineback: 'BB' };

export class Economy {
  record: EconomyRecord;
  /** ERA's policy anchor, as what this account owns names it. */
  eraAnchor = '';
  /**
   * The account's own operations that advance its state, one after another. Each player's tasks
   * run in that wallet's own queue, so two players connecting together issued two creatures at
   * once on the one account, and one of them was refused (phones, 2026-10-08).
   */
  private accountTurn: Promise<unknown> = Promise.resolve();

  /**
   * Run `op` once every account operation queued before it is done. The account admits one
   * economic step at a time (DSM refuses a second while one is pending: "an economic admission is
   * already pending"), so everything that spends from it, an object issued or a transfer sent,
   * runs in turn.
   */
  inTurn<T>(op: () => Promise<T>): Promise<T> {
    const run = this.accountTurn.then(op, op);
    this.accountTurn = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(readonly host: DsmHost, readonly path: string, account: string) {
    this.record = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as EconomyRecord)
      : { account, wild: null, vault: null, creatures: {}, nextSerial: 1, profiles: {}, stats: {}, inFlight: {}, resume: {}, welcomed: [], owed: {}, players: {}, usernames: {}, matches: {} };
    this.record.inFlight ??= {};
    this.record.resume ??= {};
    // Resume tokens kept before they named their offer named only a connection.
    for (const [token, login] of Object.entries(this.record.resume as Record<string, Login | string>)) {
      if (typeof login === 'string') this.record.resume[token] = { offer: '', session: login };
    }
    this.record.welcomed ??= [];
    this.record.owed ??= {};
    this.record.players ??= {};
    this.record.usernames ??= {};
    this.record.matches ??= {};
    if (this.record.account !== account) {
      throw new Error(`${path} is the record of account ${this.record.account}, not of ${account}`);
    }
  }

  /**
   * Keep the record on disk, now: an irreversible step that follows a save finds it written. Compact,
   * not pretty-printed, and a slow write says so with its size (phones, 2026-10-08: walking paused,
   * then went on, while the server rewrote its record).
   */
  save(): void {
    const started = performance.now();
    mkdirSync(dirname(this.path), { recursive: true });
    const next = `${this.path}.next`;
    const text = JSON.stringify(this.record);
    writeFileSync(next, text);
    renameSync(next, this.path);
    const took = Math.round(performance.now() - started);
    if (took >= 100) console.warn(`[record] ${text.length} bytes written in ${took} ms`);
  }

  get wild(): Bytes {
    if (!this.record.wild) throw new Error('the game has not created its coin yet');
    return fromB32(this.record.wild);
  }

  /** The account's ERA row: how much it owns, in hundredths of an ERA, and its anchor. */
  async eraRow(): Promise<{ available: bigint; anchor: string }> {
    const era = (await this.host.balances()).find((b) => b.tokenId === 'ERA');
    if (!era || !era.policyAnchorB32) throw new Error('the game account lists no ERA');
    this.eraAnchor = era.policyAnchorB32;
    return { available: era.available, anchor: era.policyAnchorB32 };
  }

  async era(): Promise<bigint> {
    return (await this.eraRow()).available;
  }

  get eraCommit(): Bytes {
    if (!this.eraAnchor) throw new Error('ERA has not been read yet');
    return fromB32(this.eraAnchor);
  }

  /** ERA enough for `needed` hundredths of an ERA: a faucet claim when the account owns less. */
  async ensureEra(needed: bigint, say: (line: string) => void): Promise<void> {
    let available = await this.era();
    while (available < needed) {
      say('The game account claims ERA from the network faucet for liquidity and the fees for issuing its objects');
      const claimed = await this.host.claimFaucet(fromB32(this.record.account));
      if (!claimed.success) throw new Error(`faucet.claim: ${claimed.message}`);
      const next = await this.era();
      if (next <= available) throw new Error('the accepted faucet claim did not increase available ERA');
      available = next;
    }
  }

  /** The coin and the market, once. */
  async setUp(say: (line: string) => void): Promise<void> {
    if (!this.record.wild) {
      await this.ensureEra(ERA_TO_START, say);
      say(`Issuing ${COIN.ticker}, the game's coin: an object of fixed supply ${COIN.supply}`);
      const anchor = await this.host.createToken({
        ticker: COIN.ticker,
        alias: COIN.alias,
        supply: COIN.supply,
        description: 'Wildstate coin: given by the game for victories, spent on capsules, traded for ERA.',
      });
      this.record.wild = b32(anchor);
      this.save();
    }
    await this.setUpMarket(say);
  }

  /**
   * The account's own name for lane `i`'s vault: this game's market of this pair at this fee. The
   * game recognizes its lanes by it and by nothing else, so another vault of the same objects is never
   * taken for one of them.
   */
  laneLabel(i: number): string {
    return `wildstate:market:v1:${this.record.wild!.slice(0, 16)}:${this.eraAnchor.slice(0, 16)}:${MARKET.feeBps}:lane:${i}`;
  }

  /**
   * The market, in MARKET_VAULTS lanes. The plan is written first: each lane's exact slice of the
   * single vault's reserves (or of MARKET for a new market). Then the single vault is closed, its
   * reserves returning to the account, and each lane opened and written as it is.
   */
  async setUpMarket(say: (line: string) => void): Promise<void> {
    await this.eraRow();
    const market = (this.record.market ??= {
      plan: null,
      legacyClosed: this.record.vault === null,
      lanes: Array.from({ length: MARKET_VAULTS }, () => null),
    });
    if (market.lanes.length === MARKET_VAULTS && market.lanes.every((lane) => lane !== null)) return;
    const wildIsA = (v: pb.SofiOwnedVaultV1) => b32(v.tokenAPolicyCommit) === this.record.wild;
    if (market.plan === null) {
      let wild = BigInt(MARKET.wild);
      let era = BigInt(MARKET.era) * 10n ** BigInt(ERA_DECIMALS);
      if (!market.legacyClosed) {
        const legacy = (await this.host.vaults()).find((v) => b32(v.vaultId) === this.record.vault);
        if (!legacy) throw new Error(`the market's vault ${this.record.vault!.slice(0, 8)} is not among the account's vaults`);
        if (legacy.status !== pb.SofiVaultStatus.ACTIVE) {
          throw new Error(`the market's vault ${this.record.vault!.slice(0, 8)} is not active and no division of it was written`);
        }
        wild = wildIsA(legacy) ? legacy.reserveA : legacy.reserveB;
        era = wildIsA(legacy) ? legacy.reserveB : legacy.reserveA;
      }
      market.plan = { wild: splitExact(wild, MARKET_VAULTS).map(String), era: splitExact(era, MARKET_VAULTS).map(String) };
      this.save();
    }
    if (!market.legacyClosed) {
      const legacy = (await this.host.vaults()).find((v) => b32(v.vaultId) === this.record.vault);
      // Closed earlier and not written down before a restart: the close stands.
      if (legacy?.status !== pb.SofiVaultStatus.RETIRED) {
        say(`Closing the single WILD/ERA vault to divide its liquidity across ${MARKET_VAULTS} vaults`);
        await this.host.close(fromB32(this.record.vault!));
      }
      market.legacyClosed = true;
      this.save();
    }
    for (let i = 0; i < MARKET_VAULTS; i++) {
      if (market.lanes[i]) continue;
      const label = this.laneLabel(i);
      const opened = (await this.host.vaults()).find((v) => v.label === label && v.status === pb.SofiVaultStatus.ACTIVE);
      if (opened) {
        market.lanes[i] = b32(opened.vaultId);
        this.save();
        continue;
      }
      const wild = entered(BigInt(market.plan.wild[i]), 0);
      const era = entered(BigInt(market.plan.era[i]), ERA_DECIMALS);
      say(`Opening market vault ${i + 1}/${MARKET_VAULTS}: ${wild} WILD against ${era} ERA, ${MARKET.feeBps} bps`);
      await this.eraRow();
      const created = await this.host.createVault(this.wild, wild, this.eraCommit, era, MARKET.feeBps, label);
      market.lanes[i] = b32(created.vaultId);
      this.save();
    }
  }

  /**
   * The creature `anchor`'s state `state` (canonical bytes), published as its latest. What the
   * account published before is read back from the storage nodes, never from this record: the
   * record it was issued with when there is none, else a successor naming the latest one.
   * Publishing the state already latest publishes nothing. Resolves with the state published.
   */
  publishState(anchor: string, state: Uint8Array): Promise<Uint8Array> {
    // One creature's states one after the other: two publishes that read the same tip would each
    // publish a successor of it, and a creature with two successors of one state is never fielded again.
    const run = (this.publishing.get(anchor) ?? Promise.resolve()).then(() => this.publishAfterTip(anchor, state));
    this.publishing.set(anchor, run.catch(() => {}));
    return run;
  }
  /** Each creature's publish under way, by anchor. */
  private readonly publishing = new Map<string, Promise<unknown>>();

  private async publishAfterTip(anchor: string, state: Uint8Array): Promise<Uint8Array> {
    const read = await this.host.readAuthored(fromB32(this.record.account), fromB32(anchor));
    if (!read.complete) throw new Error(`not every state of creature ${anchor.slice(0, 8)} could be read back; try again`);
    let parent: Uint8Array;
    if (read.objects.length) {
      const tip = latestCreatureState(fromB32(anchor), read.objects.map((o) => o.payload));
      if (Buffer.from(tip.state).equals(Buffer.from(state))) return state;
      parent = tip.digest;
    } else {
      // Whatever the game hands over is born at level 1 (owner ruling 2026-10-06): the record it is
      // issued with is its birth state, and what it has played to since is a successor of it.
      const species = this.record.creatures[anchor]?.species;
      if (species === undefined) throw new Error(`creature ${anchor.slice(0, 8)} is not one this account issued`);
      const birth = creatureRecord(null, birthCreatureState(fromB32(anchor), SPECIES_IDS.indexOf(species)));
      const born = await this.host.publishAuthored(fromB32(anchor), birth);
      if (!born.stored) throw new Error(`the birth state of creature ${anchor.slice(0, 8)} did not store at the storage nodes`);
      parent = creatureRecordDigest(birth);
      if (Buffer.from(birthCreatureState(fromB32(anchor), SPECIES_IDS.indexOf(species))).equals(Buffer.from(state))) return state;
    }
    const published = await this.host.publishAuthored(fromB32(anchor), creatureRecord(parent, state));
    if (!published.stored) throw new Error(`the state of creature ${anchor.slice(0, 8)} did not store at the storage nodes`);
    return state;
  }

  /** A new creature: an object of supply one whose policy says what it is. */
  async issueCreature(species: Species, say: (line: string) => void, creature?: string): Promise<string> {
    // The serial is taken before anything is awaited. A creature's anchor follows from its policy,
    // and its policy from its serial: two issuances that read one serial would issue one object of
    // supply one and bind two players to it.
    const serial = this.record.nextSerial;
    this.record.nextSerial = serial + 1;
    this.save();
    const ticker = `${CODE[species]}${String(serial).padStart(4, '0')}`;
    const name = `${SPECIES[species].name} #${serial}`;
    const anchor = b32(
      await this.inTurn(async () => {
        await this.ensureEra(CREATION_FEE_ERA, say);
        return this.host.createToken({
          ticker,
          alias: name,
          supply: 1n,
          description: `Wildstate creature: ${species}, capture ${serial}, issued by the Wildstate game account`,
        });
      }),
    );
    const already = this.record.creatures[anchor];
    if (already !== undefined) {
      throw new Error(`creature ${ticker} came out as ${already.ticker}'s anchor ${anchor.slice(0, 8)}: one object is never issued to two creatures`);
    }
    this.record.creatures[anchor] = creature === undefined ? { species, serial, ticker } : { species, serial, ticker, creature };
    this.save();
    return anchor;
  }
}

