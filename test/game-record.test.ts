import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// The game server names its record after it has loaded the game's modules: scripts/server.mjs
// sets DSM_GAME_RECORD to WILDSTATE_DATA_DIR/dsm-game.json once its imports have run. The record
// the game keeps is the one named when its world is set up, never a path fixed at load.
vi.mock('../src/integrations/dsm/host', async (original) => {
  const real = await original<typeof import('../src/integrations/dsm/host')>();
  class FixtureHost {
    constructor(readonly base: string) {}
    activity = async () => ({ deviceId: new Uint8Array(32).fill(1), storageSetId: new Uint8Array(32), signatureBytes: 0, entries: [] });
  }
  return { ...real, DsmHost: FixtureHost };
});

const before = { host: process.env.DSM_APP_HOST, secret: process.env.DSM_APP_HOST_SECRET_FILE, record: process.env.DSM_GAME_RECORD };
afterAll(() => {
  for (const [name, value] of [['DSM_APP_HOST', before.host], ['DSM_APP_HOST_SECRET_FILE', before.secret], ['DSM_GAME_RECORD', before.record]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

it('keeps its record where the server names it, even when that is after the game loaded', async () => {
  process.env.DSM_APP_HOST = 'http://fixture.invalid';
  process.env.DSM_APP_HOST_SECRET_FILE = 'fixture.invalid/ingress-token';
  delete process.env.DSM_GAME_RECORD;
  const dsm = await import('../src/modules/main/dsm');
  // Named after the load, as the server does it. It holds another account's record, so setting
  // up the world stops there, naming the file it read.
  const record = join(mkdtempSync(join(tmpdir(), 'game-record-')), 'dsm-game.json');
  writeFileSync(record, JSON.stringify({ account: 'ANOTHER-ACCOUNT' }));
  process.env.DSM_GAME_RECORD = record;
  await expect(dsm.world()).rejects.toThrow(`${record} is the record of account ANOTHER-ACCOUNT`);
});
