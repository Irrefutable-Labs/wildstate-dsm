/**
 * Real DSM accounts for the end-to-end suites: `dsm-app-host` processes, the binary the game's
 * account runs in production, on the storage nodes the env config names.
 *
 * One process is the game's own account; the others are players' wallets. A wallet here is the
 * same SDK on the same ingress a phone's wallet screen uses: it reads a connect code, approves it,
 * and answers the game's requests under its grant through its own inbox poller. Nothing in these
 * suites stands in for DSM, forwards a message or answers for a node.
 *
 * Required, or the suite refuses (it never skips):
 * - `DSM_APP_HOST_BIN`: the `dsm-app-host` binary, built from the DSM revision under test;
 * - `DSM_ENV_CONFIG`: the env config naming the storage set that revision pins, with its CA beside it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DsmHost, HostError, b32, own, type Bytes } from '../../src/integrations/dsm/host';
import * as pb from '../../src/integrations/dsm/proto/dsm_app_pb';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: the real-DSM suites run against a real dsm-app-host and storage set, and refuse rather than skip ` +
      '(DSM_APP_HOST_BIN = the dsm-app-host binary, DSM_ENV_CONFIG = the env config of the storage set it pins)',
    );
  }
  if (!existsSync(value)) throw new Error(`${name} names ${value}, which does not exist`);
  return value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

/** One run's directory: every account's data, secret and log. */
export const runDir = (name: string): string => mkdtempSync(join(tmpdir(), `wildstate-${name}-`));

/** A `dsm-app-host` process: one DSM account. */
export class Account {
  private child: ChildProcess | null = null;
  private starts = 0;
  readonly ingress: string;
  readonly secretFile: string;
  readonly host: DsmHost;
  private readonly args: string[];

  private constructor(readonly name: string, private readonly dir: string, game: number, relay: number) {
    const secretDir = join(dir, `${name}-ingress`);
    this.secretFile = join(secretDir, 'ingress-token');
    this.ingress = `http://127.0.0.1:${game}`;
    this.args = [
      '--data-dir', join(dir, name),
      '--ingress-secret-dir', secretDir,
      '--env-config', required('DSM_ENV_CONFIG'),
      '--game-bind', `127.0.0.1:${game}`,
      '--relay-bind', `127.0.0.1:${relay}`,
      '--relay-endpoint', `https://127.0.0.1:${relay}`,
      '--relay-name', '127.0.0.1',
    ];
    this.host = new DsmHost(this.ingress, this.secretFile);
  }

  static async start(name: string, dir: string): Promise<Account> {
    const account = new Account(name, dir, await freePort(), await freePort());
    await account.start();
    return account;
  }

  /** Where this account's processes logged, one file per start. */
  log(start = this.starts): string {
    return join(this.dir, `${this.name}-${start}.log`);
  }

  /** Start the process (again, on the same account) and wait until its ingress answers with this launch's secret. */
  async start(): Promise<void> {
    this.starts += 1;
    const log = createWriteStream(this.log());
    const child = spawn(required('DSM_APP_HOST_BIN'), this.args, { env: { ...process.env, RUST_LOG: 'info' } });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    this.child = child;
    let exited: string | null = null;
    child.once('exit', (code, signal) => { exited = `${code ?? signal}`; });
    const deadline = Date.now() + 240_000;
    for (;;) {
      if (exited !== null) throw new Error(`${this.name}: dsm-app-host exited (${exited}): see ${this.log()}`);
      let why: string;
      try {
        await this.host.activity(0n);
        return;
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      if (Date.now() > deadline) throw new Error(`${this.name} did not come up within 240 s (${why}): see ${this.log()}`);
      await sleep(500);
    }
  }

  /** Kill the process, as a phone kills an app. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await gone;
  }

  async deviceId(): Promise<string> {
    return b32((await this.host.activity(0n)).deviceId);
  }

  /** What `balance.list` says this account can spend of `ticker`, the number its wallet screen shows (0 when it holds none). */
  async available(ticker: string): Promise<bigint> {
    const held = (await this.host.balances()).find((b) => b.tokenId === ticker);
    return held ? held.available : 0n;
  }

  private static reply(route: string, payload: pb.Envelope['payload']): pb.ConnectReplyV1['reply'] {
    if (payload.case !== 'connectReply') throw new HostError(`${route} answered ${payload.case}`);
    return payload.value.reply;
  }

  /**
   * As a player does in the wallet: read the game's connect code (fetched from the game's relay
   * over TLS bound to the code's pin) and approve the grant it asks for, as offered. The session id.
   */
  async approve(code: string, expectApp: string): Promise<Bytes> {
    const preview = Account.reply(
      'connect.preview',
      await this.host.query('connect.preview', new pb.ConnectPreviewRequestV1({ code }).toBinary()),
    );
    if (preview.case !== 'preview') throw new HostError(`connect.preview answered ${preview.case}`);
    if (preview.value.displayName !== expectApp) throw new HostError(`the code names ${preview.value.displayName}, not ${expectApp}`);
    const approved = Account.reply(
      'connect.approve',
      await this.host.invoke('connect.approve', new pb.ConnectApproveRequestV1({ offerDigest: preview.value.offerDigest }).toBinary()),
    );
    if (approved.case !== 'session') throw new HostError(`connect.approve answered ${approved.case}`);
    return own(approved.value.sessionId);
  }

  /**
   * As a player does in the wallet's Apps → Waiting: wait for a request the grant does not cover
   * and that `which` picks, then approve it. The request as the wallet listed it.
   */
  async approvePending(what: string, which: (p: pb.ConnectPendingV1) => boolean): Promise<pb.ConnectPendingV1> {
    const waiting = await until(`${this.name}: ${what} waits for the player`, 600_000, async () => {
      const list = Account.reply('connect.pending', await this.host.query('connect.pending', new Uint8Array()));
      if (list.case !== 'pending') throw new HostError(`connect.pending answered ${list.case}`);
      return list.value.pending.find((p) => !p.approved && which(p)) ?? null;
    });
    const decided = Account.reply(
      'connect.respond',
      await this.host.invoke('connect.respond', new pb.ConnectRespondRequestV1({
        sessionId: waiting.sessionId, seq: waiting.seq, decision: pb.ConnectDecision.APPROVE,
      }).toBinary()),
    );
    if (decided.case !== 'decided') throw new HostError(`connect.respond answered ${decided.case}`);
    return waiting;
  }
}

/** `probe` until it holds, or fail naming `what` and the last reason it did not. */
export async function until<T>(what: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms;
  let why = 'not yet';
  for (;;) {
    try {
      const got = await probe();
      if (got !== null) return got;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms / 1000} s (${why})`);
    await sleep(1000);
  }
}
