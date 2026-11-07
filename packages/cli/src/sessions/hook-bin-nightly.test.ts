// The built `dist/hook-bin.js nightly`, run as the scheduled task runs it, in a temp home with a pool stub on localhost (t884 fix round): the nightly entry calls the pool send, which reads the covenant first and sends nothing unless it is accepted.
// Like `telemetry/hook-bin-telemetry.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const hookBin = fileURLToPath(new URL('../../dist/hook-bin.js', import.meta.url));
const built = existsSync(hookBin);

const made: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

/** A pool stub that records each request line and answers the covenant read with `accepted`; anything else gets 404. */
const stub = async (accepted: boolean): Promise<{ origin: string; seen: string[] }> => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/covenant') {
      response.end(JSON.stringify({ version: 'v1', accepted }));
      return;
    }
    response.statusCode = 404;
    response.end('{"error":"not_found","message":"No such route."}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub did not listen');
  return { origin: `http://127.0.0.1:${String(address.port)}`, seen };
};

/** A temp home with a pool sign-in for `origin`, so the nightly send gets as far as the covenant read. */
const home = (origin: string | undefined): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-nightly-bin-'));
  made.push(folder);
  const store = join(folder, 'oars', 'sessions');
  mkdirSync(store, { recursive: true });
  if (origin !== undefined) {
    writeFileSync(join(store, 'pool-accounts.json'), JSON.stringify([{ server: origin, account: 'acct_one', token: 'a-pool-token', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'k' } }]));
  }
  return folder;
};

const nightly = (folder: string, origin: string): Promise<number | null> =>
  new Promise((resolve, reject) => {
    // Telemetry is off so the only requests the stub sees are the pool send's.
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_POOL_URL: origin, OARS_TELEMETRY: '0' };
    const child = spawn(process.execPath, [hookBin, 'nightly'], { cwd: folder, env, stdio: 'ignore', timeout: 30_000 });
    child.on('error', reject);
    child.on('close', resolve);
  });

const outcomeOf = (folder: string): unknown => {
  const parsed: unknown = JSON.parse(readFileSync(join(folder, 'oars', 'sessions', 'pool-nightly.json'), 'utf8'));
  return typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'outcome') : undefined;
};

describe.skipIf(!built)('the built nightly task', () => {
  it('reads the covenant, and when it is not accepted sends nothing else', async () => {
    const pool = await stub(false);
    const folder = home(pool.origin);
    expect(await nightly(folder, pool.origin)).toBe(0);
    expect(pool.seen).toEqual(['GET /v1/covenant']);
    expect(outcomeOf(folder)).toBe('not-accepted');
  });

  it('reads the covenant and goes on to the send when it is accepted', async () => {
    const pool = await stub(true);
    const folder = home(pool.origin);
    expect(await nightly(folder, pool.origin)).toBe(0);
    expect(pool.seen).toEqual(['GET /v1/covenant']);
    // Nothing is queued in this store, so the night sends no batch, but it got past the acceptance gate.
    expect(outcomeOf(folder)).toBe('sent');
  });

  it('makes no request to the pool with no sign-in', async () => {
    const pool = await stub(true);
    const folder = home(undefined);
    expect(await nightly(folder, pool.origin)).toBe(0);
    expect(pool.seen).toEqual([]);
    expect(outcomeOf(folder)).toBe('not-signed-in');
  });
});
