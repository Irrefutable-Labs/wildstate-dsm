/**
 * The game's own DSM account, reached through `dsm-app-host` on this machine.
 *
 * The host speaks the DSM SDK's protobuf ingress (the boundary a phone's
 * wallet screen uses) and keeps a record of what each call did to the
 * account. This client only frames requests and reads answers: every DSM
 * decision is the SDK's, inside the host. Nothing here is evidence; what the
 * game grants on comes from `connect.app.status`, which reports only facts
 * the account established itself (DSM Amendment A11).
 */
import * as pb from './proto/dsm_app_pb';

type Payload = pb.Envelope['payload'];

export class HostError extends Error {}

/** Bytes this process owns (a plain ArrayBuffer), as protobuf fields and request bodies take them. */
export type Bytes = Uint8Array<ArrayBuffer>;
export const own = (b: Uint8Array): Bytes => new Uint8Array(b);

/** The host's answer to a route: its envelope payload, or the route's refusal. */
function payloadOf(route: string, response: pb.IngressResponse): Payload {
  if (response.result.case === 'error') throw new HostError(`${route}: ${response.result.value.message}`);
  if (response.result.case !== 'okBytes') throw new HostError(`${route}: the host answered nothing`);
  const bytes = response.result.value;
  if (bytes[0] !== 0x03) throw new HostError(`${route}: the answer is not a framed envelope`);
  const envelope = pb.Envelope.fromBinary(bytes.subarray(1));
  if (envelope.payload.case === 'error') throw new HostError(`${route}: ${envelope.payload.value.message}`);
  return envelope.payload;
}

function argPack(body: Uint8Array): Bytes {
  return own(new pb.ArgPack({ codec: pb.Codec.PROTO, body: own(body) }).toBinary());
}

export const b32 = (bytes: Uint8Array): string => {
  // Base32 Crockford, as DSM shows ids at its human edges.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
};

export const fromB32 = (text: string): Bytes => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text.toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error(`not Base32 Crockford: ${text}`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
};

export const short = (bytes: Uint8Array | string): string =>
  (typeof bytes === 'string' ? bytes : b32(bytes)).slice(0, 8);

/** The longest one call to the game's account may take: a lineage walk on a cold account can take a minute. */
const HOST_CALL_TIMEOUT_MS = 120_000;

export class DsmHost {
  /**
   * `secretFile` is the host's `<ingress-secret-dir>/ingress-token`. The host writes a
   * new secret there at every launch and refuses a call without it, so the
   * file is read for each call: a restarted host is reached with its new one.
   */
  constructor(readonly base: string, private readonly secretFile: string) {}

  private async authorization(): Promise<string> {
    // Node only: the secret lives on the game server's disk.
    const { readFile } = await import('node:fs/promises');
    let secret = '';
    try {
      secret = (await readFile(this.secretFile, 'utf8')).trim();
    } catch (e) {
      // The path and the file system's words stay on the server's own log; a player sees only that the account is unreachable.
      console.error(`[dsm] the ingress secret file could not be read: ${this.secretFile}: ${String(e)}`);
      throw new HostError('the game account ingress secret is unavailable');
    }
    if (secret.length === 0) {
      console.error(`[dsm] the ingress secret file is empty: ${this.secretFile}`);
      throw new HostError('the game account ingress secret is unavailable');
    }
    return `Bearer ${secret}`;
  }

  private async ingress(request: pb.IngressRequest, quiet: boolean): Promise<pb.IngressResponse> {
    const path = quiet ? '/ingress/quiet' : '/ingress';
    const op = request.operation.value as { method?: string } | undefined;
    const started = Date.now();
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf', authorization: await this.authorization() },
        body: own(request.toBinary()),
        // A call the account never answers fails, instead of holding its player forever.
        signal: AbortSignal.timeout(HOST_CALL_TIMEOUT_MS),
      });
      if (!res.ok) throw new HostError(`${path}: the host answered ${res.status}: ${await res.text()}`);
      return pb.IngressResponse.fromBinary(new Uint8Array(await res.arrayBuffer()));
    } finally {
      const ms = Date.now() - started;
      if (ms >= 250) console.log(`[host] ${op?.method ?? request.operation.case} took ${ms} ms`);
    }
  }

  async invoke(method: string, body: Uint8Array, quiet = false): Promise<Payload> {
    const request = new pb.IngressRequest({
      operation: { case: 'routerInvoke', value: new pb.RouterInvokeOp({ method, args: argPack(body) }) },
    });
    return payloadOf(method, await this.ingress(request, quiet));
  }

  async query(method: string, body: Uint8Array): Promise<Payload> {
    const request = new pb.IngressRequest({
      operation: { case: 'routerQuery', value: new pb.RouterQueryOp({ method, args: argPack(body) }) },
    });
    return payloadOf(method, await this.ingress(request, true));
  }

  /** What the host recorded after `after`, and who this account is. */
  async activity(after: bigint): Promise<pb.AppHostActivityV1> {
    const res = await fetch(`${this.base}/activity/${after}`, { headers: { authorization: await this.authorization() } });
    if (!res.ok) throw new HostError(`/activity: the host answered ${res.status}`);
    return pb.AppHostActivityV1.fromBinary(new Uint8Array(await res.arrayBuffer()));
  }

  private connectReply(route: string, payload: Payload): pb.ConnectReplyV1['reply'] {
    if (payload.case !== 'connectReply') throw new HostError(`${route} answered ${payload.case}`);
    return payload.value.reply;
  }

  async balances(): Promise<pb.BalanceGetResponse[]> {
    const payload = await this.query('balance.list', new Uint8Array());
    if (payload.case !== 'balancesListResponse') throw new HostError(`balance.list answered ${payload.case}`);
    return payload.value.balances;
  }

  /** Take in what the storage nodes hold for the account and push what it owes: the inbox poller's sync. */
  async sync(): Promise<pb.StorageSyncResponse> {
    // An invoke: the sync writes what it takes in, and the router takes it only as one.
    const payload = await this.invoke(
      'storage.sync',
      new pb.StorageSyncRequest({ pullInbox: true, pushPending: true, limit: 50 }).toBinary(),
      true,
    );
    if (payload.case !== 'storageSyncResponse') throw new HostError(`storage.sync answered ${payload.case}`);
    return payload.value;
  }

  async claimFaucet(deviceId: Bytes): Promise<pb.FaucetClaimResponse> {
    const payload = await this.invoke('faucet.claim', new pb.FaucetClaimRequest({ deviceId }).toBinary());
    if (payload.case !== 'faucetClaimResponse') throw new HostError(`faucet.claim answered ${payload.case}`);
    return payload.value;
  }

  /** A token of the game's: its whole supply is the game account's at creation. */
  async createToken(args: {
    ticker: string;
    alias: string;
    supply: bigint;
    description: string;
  }): Promise<Uint8Array> {
    const payload = await this.invoke(
      'token.create',
      new pb.TokenCreateRequest({
        ticker: args.ticker,
        alias: args.alias,
        decimals: 0,
        // Whole units as digits: the SDK parses the amount the player entered (decimals 0).
        genesisSupplyEntered: args.supply.toString(),
        burnEnabled: false,
        transferable: true,
        threshold: 1,
        description: args.description,
      }).toBinary(),
    );
    if (payload.case !== 'tokenCreateResponse') throw new HostError(`token.create answered ${payload.case}`);
    return payload.value.policyAnchor;
  }

  /**
   * A SoFi vault of the game's own, funded from its account (SoFi §28). `label` is the account's
   * own name for it (bookkeeping only, never protocol): how the game recognizes its market's vaults.
   */
  async createVault(a: Bytes, reserveA: string, b: Bytes, reserveB: string, feeBps: number, label = '') {
    const less = (x: Uint8Array, y: Uint8Array) => {
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i];
      return x.length < y.length;
    };
    const [lo, rLo, hi, rHi] = less(a, b) ? [a, reserveA, b, reserveB] : [b, reserveB, a, reserveA];
    const payload = await this.invoke(
      'sofi.createVault',
      new pb.SofiCreateVaultRequest({
        tokenAPolicyCommit: lo,
        tokenBPolicyCommit: hi,
        reserveAEntered: rLo,
        reserveBEntered: rHi,
        feeBps,
        label,
      }).toBinary(),
    );
    if (payload.case !== 'sofiVaultCreatedResponse') throw new HostError(`sofi.createVault answered ${payload.case}`);
    return payload.value;
  }

  /**
   * Close a vault this account owns (`sofi.close`, SoFi §32): its reserves return to the account.
   * Resolves once the close is realized; any other outcome is an error, and nothing is assumed.
   */
  async close(vaultId: Bytes): Promise<void> {
    const payload = await this.invoke('sofi.close', new pb.SofiCloseRequest({ vaultId }).toBinary());
    if (payload.case !== 'sofiPositionResponse') throw new HostError(`sofi.close answered ${payload.case}`);
    if (payload.value.state !== pb.SofiPositionState.REALIZED) {
      throw new HostError(`sofi.close: the close at position ${payload.value.position} is ${pb.SofiPositionState[payload.value.state]}, not realized`);
    }
  }

  async vaults(): Promise<pb.SofiOwnedVaultV1[]> {
    const payload = await this.invoke('sofi.vaults', new pb.SofiVaultsRequest().toBinary(), true);
    if (payload.case !== 'sofiVaultsResponse') throw new HostError(`sofi.vaults answered ${payload.case}`);
    return payload.value.vaults;
  }

  /**
   * A route's price over the market's vaults, found by this account (`sofi.findRoute`): information
   * only, read from the vaults' public state. No route among vaults that could not all be read is an
   * error, never "no route".
   */
  async findRoute(tokenIn: Bytes, tokenOut: Bytes, amountInEntered: string): Promise<pb.SofiFindRouteResponse> {
    const payload = await this.invoke(
      'sofi.findRoute',
      new pb.SofiFindRouteRequest({ tokenInPolicyCommit: tokenIn, tokenOutPolicyCommit: tokenOut, amountInEntered }).toBinary(),
      true,
    );
    if (payload.case !== 'sofiFindRouteResponse') throw new HostError(`sofi.findRoute answered ${payload.case}`);
    if (payload.value.hops.length === 0 && payload.value.search !== pb.SofiSearch.COMPLETE) {
      throw new HostError('no route among the liquidity that could be read; some could not be reached, try again');
    }
    return payload.value;
  }

  /** An online transfer from the game's account (`wallet.sendSmart`). */
  async send(to: Bytes, ticker: string, amount: string, memo: string): Promise<void> {
    await this.invoke(
      'wallet.sendSmart',
      new pb.OnlineTransferSmartRequest({ recipientDeviceId: to, tokenId: ticker, amount, memo }).toBinary(),
    );
  }

  /**
   * An offer this account signs. `freeRequests` is how many requests that spend
   * nothing the game asks to make over the session's life: the player's grant
   * names it, and past it each request waits for the player (DSM SA-78).
   */
  async offer(
    displayName: string,
    scopes: pb.ConnectScopeV1[],
    anchors: Uint8Array[],
    freeRequests: number,
  ): Promise<pb.ConnectAppOfferV1> {
    // The host names its own relay endpoint and certificate pin.
    const reply = this.connectReply(
      'connect.app.offer',
      await this.invoke(
        'connect.app.offer',
        new pb.ConnectAppOfferRequestV1({ displayName, scopes, tokenAnchors: anchors, freeRequests }).toBinary(),
      ),
    );
    if (reply.case !== 'offer') throw new HostError(`connect.app.offer answered ${reply.case}`);
    return reply.value;
  }

  /** An offer this account made, by its digest: its code, as the relay serves it. */
  async offerOf(offerDigest: Bytes): Promise<pb.ConnectAppOfferV1> {
    const reply = this.connectReply(
      'connect.app.offerOf',
      await this.query('connect.app.offerOf', new pb.ConnectOfferRefV1({ offerDigest }).toBinary()),
    );
    if (reply.case !== 'offer') throw new HostError(`connect.app.offerOf answered ${reply.case}`);
    return reply.value;
  }

  async sessions(): Promise<pb.ConnectSessionV1[]> {
    const reply = this.connectReply('connect.app.sessions', await this.query('connect.app.sessions', new Uint8Array()));
    if (reply.case !== 'sessions') throw new HostError(`connect.app.sessions answered ${reply.case}`);
    return reply.value.sessions;
  }

  async request(sessionId: Bytes, kind: pb.ConnectAppRequestIntentV1['kind']): Promise<bigint> {
    const reply = this.connectReply(
      'connect.app.request',
      await this.invoke('connect.app.request', new pb.ConnectAppRequestIntentV1({ sessionId, kind }).toBinary()),
    );
    if (reply.case !== 'request') throw new HostError(`connect.app.request answered ${reply.case}`);
    return reply.value.seq;
  }

  /**
   * Publish `payload` as an object of this account's on `topic` (`authored.publish`): content
   * addressed, signed by the account's key, found by anyone under the account's locator for the topic.
   */
  async publishAuthored(topic: Bytes, payload: Bytes): Promise<pb.AuthoredPublishedResponse> {
    const payloadOf = await this.invoke('authored.publish', new pb.AuthoredPublishRequestV1({ topic, payload }).toBinary());
    if (payloadOf.case !== 'authoredPublishedResponse') throw new HostError(`authored.publish answered ${payloadOf.case}`);
    return payloadOf.value;
  }

  /** Every object `author` published on `topic`, each checked from its own bytes (`authored.read`). */
  async readAuthored(author: Bytes, topic: Bytes): Promise<pb.AuthoredObjectsResponse> {
    const payloadOf = await this.query('authored.read', new pb.AuthoredReadRequestV1({ authorDeviceId: author, topic }).toBinary());
    if (payloadOf.case !== 'authoredObjectsResponse') throw new HostError(`authored.read answered ${payloadOf.case}`);
    return payloadOf.value;
  }

  /** What the account established about request `seq`. `recorded` puts the check in the record. */
  async status(sessionId: Bytes, seq: bigint, recorded = false): Promise<pb.ConnectAppStatusV1> {
    const reply = this.connectReply(
      'connect.app.status',
      await this.invoke('connect.app.status', new pb.ConnectRequestRefV1({ sessionId, seq }).toBinary(), !recorded),
    );
    if (reply.case !== 'status') throw new HostError(`connect.app.status answered ${reply.case}`);
    return reply.value;
  }
}
