import { describe, expect, it } from 'vitest';
import { b32, fromB32, own } from '../src/integrations/dsm/host';

describe('the game reads DSM ids as DSM writes them', () => {
  it("reads and writes ERA's policy anchor byte for byte (Base32 Crockford, the SDK's vector)", () => {
    const era = 'NNG176RZ6ACTWCDPRNYHXZK2DCZ72SPA9Q6XWGRGQ9JGKZYTESG0';
    const bytes = fromB32(era);
    expect(bytes.length).toBe(32);
    expect(b32(bytes)).toBe(era);
    expect(b32(fromB32(era.toLowerCase()))).toBe(era);
  });
  it('refuses text that is not Base32 Crockford', () => {
    expect(() => fromB32('NOT-BASE32!')).toThrow('not Base32 Crockford');
  });
  it('copies bytes into a buffer this process owns', () => {
    const view = new Uint8Array(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2);
    const owned = own(view);
    expect([...owned]).toEqual([8, 7]);
    expect(owned.buffer.byteLength).toBe(2);
  });
});

describe("the game reaches its account with the host's ingress secret", () => {
  it('sends the secret the file holds on every call, and the new one after the host rotates it', async () => {
    const { createServer } = await import('node:http');
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DsmHost } = await import('../src/integrations/dsm/host');
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.statusCode = 401;
      res.end('refused');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the test server has no port');
    const dir = await mkdtemp(join(tmpdir(), 'wildstate-secret-'));
    const secretFile = join(dir, 'ingress-token');
    try {
      const host = new DsmHost(`http://127.0.0.1:${address.port}`, secretFile);
      await writeFile(secretFile, 'FIRSTSECRET');
      await expect(host.activity(0n)).rejects.toThrow('401');
      await writeFile(secretFile, 'SECONDSECRET\n');
      await expect(host.balances()).rejects.toThrow('401');
      expect(seen).toEqual(['Bearer FIRSTSECRET', 'Bearer SECONDSECRET']);
    } finally {
      server.close();
      await rm(dir, { recursive: true });
    }
  });
  it('refuses to call with an empty secret file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DsmHost } = await import('../src/integrations/dsm/host');
    const dir = await mkdtemp(join(tmpdir(), 'wildstate-secret-'));
    const secretFile = join(dir, 'ingress-token');
    try {
      await writeFile(secretFile, '');
      await expect(new DsmHost('http://127.0.0.1:9', secretFile).activity(0n)).rejects.toThrow('holds no ingress secret');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('the game asks its account for a sync the way the router takes one', () => {
  it('sends storage.sync as an invoke: the sync writes what it takes in', async () => {
    const { createServer } = await import('node:http');
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DsmHost } = await import('../src/integrations/dsm/host');
    const pb = await import('../src/integrations/dsm/proto/dsm_app_pb');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const operation = pb.IngressRequest.fromBinary(new Uint8Array(Buffer.concat(chunks))).operation;
        const method = (operation.value as { method?: string } | undefined)?.method;
        seen.push(`${operation.case} ${method}`);
        res.statusCode = 401;
        res.end('refused');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the test server has no port');
    const dir = await mkdtemp(join(tmpdir(), 'wildstate-sync-'));
    const secretFile = join(dir, 'ingress-token');
    try {
      await writeFile(secretFile, 'SECRET');
      await expect(new DsmHost(`http://127.0.0.1:${address.port}`, secretFile).sync()).rejects.toThrow('401');
      expect(seen).toEqual(['routerInvoke storage.sync']);
    } finally {
      server.close();
      await rm(dir, { recursive: true });
    }
  });
});
