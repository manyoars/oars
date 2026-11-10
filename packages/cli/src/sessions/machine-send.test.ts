// The machine's side of the pool: activation, rotation, the key file, sending what the outbox held, and the expiry notice. The pool is a function the test drives; the store is a temp folder.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POOL_URL, type Reply, type Sender } from './pool-command.js';
import { keyFile, tokenFile } from './machine-credential.js';
import { messageOf, noticeFile, takeNotice } from './machine-notice.js';
import { nightlyPoolDeps } from './pool-nightly-deps.js';
import { machineSend } from './machine-send.js';
import { outboxFolder, writeBatch } from './pool-outbox.js';
import { sentHashes } from './pool-sent.js';
import { cleanup, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-09T00:00:00Z');
const TOKEN = 'oars_mt_token-secret-value';
const KEY = 'oars_mk_rotated-key-secret-value';

interface Pool {
  accepted: boolean;
  expiresAt: number;
  /** Answers by `METHOD path`, else the default for the route. */
  answers: { [route: string]: Reply };
  calls: Array<{ route: string; authorization: string | undefined }>;
}

const reply = (status: number, body: unknown): Reply => ({ status, body, headers: new Headers() });
const error = (status: number, code: string): Reply => reply(status, { error: code, message: `refused: ${code}` });

const poolOf = (over: Partial<Pool> = {}): Pool => ({ accepted: true, expiresAt: NOW + 60 * DAY, answers: {}, calls: [], ...over });

const senderOf = (pool: Pool, rotate: boolean): Sender => (request) => {
  const route = `${request.method} ${request.url.pathname}`;
  pool.calls.push({ route, authorization: request.headers.find(([name]) => name === 'authorization')?.[1] });
  const given = pool.answers[route];
  if (given !== undefined) return Promise.resolve(given);
  if (route === 'POST /v1/machines/activate') return Promise.resolve(reply(200, { machine: { id: 'm', expiresAt: pool.expiresAt }, rotate }));
  if (route === 'POST /v1/machines/rotate') return Promise.resolve(reply(200, { machine: { id: 'm' }, key: KEY }));
  if (route === 'GET /v1/covenant') return Promise.resolve(reply(200, { version: '1', accepted: pool.accepted, machineExpiresAt: pool.expiresAt }));
  return Promise.resolve(reply(201, { ok: true, id: 'x', machineExpiresAt: pool.expiresAt }));
};

const scene = (hostClass: 'cloud' | 'vps'): { staged: Staged; env: NodeJS.ProcessEnv; deps: ReturnType<typeof nightlyPoolDeps>; outbox: string } => {
  const staged = stage();
  const env: NodeJS.ProcessEnv = { OARS_HOST_CLASS: hostClass, OARS_MACHINE: 'm-1', APPDATA: staged.root };
  mkdirSync(staged.storeDir, { recursive: true });
  return { staged, env, deps: nightlyPoolDeps(env, staged.runtime, '0.0.0-test', () => NOW), outbox: outboxFolder(staged.storeDir, DEFAULT_POOL_URL) };
};

const hold = async (outbox: string, key = '0123456789abcdef'): Promise<string> => (await writeBatch(outbox, key, { format: 1, id: key, transcripts: [] })).hash;

const readFileOrEmpty = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const deposits = (pool: Pool): number => pool.calls.filter((call) => call.route === 'POST /v1/deposits').length;
const routes = (pool: Pool, route: string): number => pool.calls.filter((call) => call.route === route).length;

describe('a cloud machine: the proxy holds the token', () => {
  it('activates a fresh VM, sends no Authorization header on any call, deposits, and activates once per VM', async () => {
    const { staged, deps, outbox } = scene('cloud');
    const hash = await hold(outbox);
    const pool = poolOf();
    expect(await machineSend(deps, senderOf(pool, false))).toEqual({ outcome: 'sent', batches: 1 });
    expect(pool.calls.map((call) => call.route)).toEqual(['POST /v1/machines/activate', 'GET /v1/covenant', 'POST /v1/deposits']);
    expect(pool.calls.every((call) => call.authorization === undefined)).toBe(true);
    expect(existsSync(keyFile(staged.storeDir))).toBe(false);
    expect((await sentHashes(outbox)).has(hash)).toBe(true);
    await hold(outbox, 'fedcba9876543210');
    await machineSend(deps, senderOf(pool, false));
    expect(routes(pool, 'POST /v1/machines/activate')).toBe(1);
    expect(deposits(pool)).toBe(2);
  });

  it('makes no call on a hold-only enrollment, which says so with OARS_HOLD_ONLY', async () => {
    const { staged, env, deps, outbox } = scene('cloud');
    env.OARS_HOLD_ONLY = '1';
    await hold(outbox);
    const pool = poolOf();
    expect(await machineSend(deps, senderOf(pool, false))).toEqual({ outcome: 'no-credential', batches: 0 });
    expect(pool.calls).toEqual([]);
    expect(existsSync(noticeFile(staged.storeDir))).toBe(false);
  });

  it('tells the person when a cloud machine without the marker gets 401 unauthorized: the proxy secret is wrong or old', async () => {
    const { staged, deps, outbox } = scene('cloud');
    await hold(outbox);
    const pool = poolOf({ answers: { 'POST /v1/machines/activate': error(401, 'unauthorized') } });
    expect(await machineSend(deps, senderOf(pool, false))).toEqual({ outcome: 'refused', batches: 0 });
    expect(readFileOrEmpty(join(staged.storeDir, 'pool-send.log'))).toContain('unauthorized');
    expect(takeNotice(staged.storeDir)).toContain('does not know the credential');
  });
});

describe('a durable machine: activation, rotation, the key file', () => {
  it('rotates once, writes the key and deletes the token, and the next run uses the key with no activate call', async () => {
    const { staged, env, deps, outbox } = scene('vps');
    writeFileSync(tokenFile(env, staged.storeDir), `${TOKEN}\n`);
    await hold(outbox);
    const pool = poolOf();
    expect(await machineSend(deps, senderOf(pool, true))).toEqual({ outcome: 'sent', batches: 1 });
    expect(pool.calls.map((call) => call.route)).toEqual(['POST /v1/machines/activate', 'POST /v1/machines/rotate', 'GET /v1/covenant', 'POST /v1/deposits']);
    expect(pool.calls.slice(0, 2).every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(pool.calls.slice(2).every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(readFileSync(keyFile(staged.storeDir), 'utf8').trim()).toBe(KEY);
    expect(existsSync(tokenFile(env, staged.storeDir))).toBe(false);
    await hold(outbox, 'fedcba9876543210');
    const again = poolOf();
    await machineSend(deps, senderOf(again, true));
    expect(again.calls.map((call) => call.route)).toEqual(['GET /v1/covenant', 'POST /v1/deposits']);
    expect(again.calls[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it('recovers from a crash after the key was written and before the token was deleted: no activate call, the spent token goes', async () => {
    const { staged, env, deps, outbox } = scene('vps');
    writeFileSync(tokenFile(env, staged.storeDir), `${TOKEN}\n`);
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    await hold(outbox);
    const pool = poolOf();
    await machineSend(deps, senderOf(pool, true));
    expect(routes(pool, 'POST /v1/machines/activate')).toBe(0);
    expect(existsSync(tokenFile(env, staged.storeDir))).toBe(false);
    expect(pool.calls.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('a refused rotate leaves the token, and the next run rotates', async () => {
    const { staged, env, deps } = scene('vps');
    writeFileSync(tokenFile(env, staged.storeDir), `${TOKEN}\n`);
    const pool = poolOf({ answers: { 'POST /v1/machines/rotate': error(500, 'internal') } });
    expect((await machineSend(deps, senderOf(pool, true))).outcome).toBe('refused');
    expect(existsSync(keyFile(staged.storeDir))).toBe(false);
    expect(existsSync(tokenFile(env, staged.storeDir))).toBe(true);
    const next = poolOf();
    await machineSend(deps, senderOf(next, true));
    expect(readFileSync(keyFile(staged.storeDir), 'utf8').trim()).toBe(KEY);
  });

  it('a rotate the pool made but the machine never wrote down leaves a retired token and no key: every run is told to enroll again', async () => {
    const { staged, env, deps, outbox } = scene('vps');
    writeFileSync(tokenFile(env, staged.storeDir), `${TOKEN}
`);
    await hold(outbox);
    const pool = poolOf({ answers: { 'POST /v1/machines/activate': error(401, 'token_retired') } });
    expect(await machineSend(deps, senderOf(pool, true))).toEqual({ outcome: 'refused', batches: 0 });
    expect(deposits(pool)).toBe(0);
    const text = takeNotice(staged.storeDir);
    expect(text).toContain('Enroll the machine again');
    expect(text).toContain('oars pool machines');
    expect(text).not.toContain(TOKEN);
  });

  it('holds no credential: it makes no call', async () => {
    const { deps } = scene('vps');
    const pool = poolOf();
    expect(await machineSend(deps, senderOf(pool, true))).toEqual({ outcome: 'no-credential', batches: 0 });
    expect(pool.calls).toEqual([]);
  });

  it('puts no key or token value in any file but the key file', async () => {
    const { staged, env, deps, outbox } = scene('vps');
    writeFileSync(tokenFile(env, staged.storeDir), `${TOKEN}\n`);
    await hold(outbox);
    await machineSend(deps, senderOf(poolOf({ expiresAt: NOW + 3 * DAY, answers: { 'POST /v1/deposits': error(422, 'closed_vocabulary') } }), true));
    for (const name of readdirSync(staged.storeDir, { recursive: true, encoding: 'utf8' })) {
      if (name === 'machine-key') continue;
      const file = join(staged.storeDir, name);
      const text = readFileOrEmpty(file);
      expect(text, name).not.toContain(KEY);
      expect(text, name).not.toContain(TOKEN);
    }
    expect(existsSync(join(staged.storeDir, 'pool-send.log'))).toBe(true);
  });
});

describe('sending the outbox', () => {
  it('sends a batch held before the covenant was accepted once, in a later run, and not again', async () => {
    const { staged, deps, outbox } = scene('vps');
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    const hash = await hold(outbox);
    const closed = poolOf({ accepted: false });
    expect(await machineSend(deps, senderOf(closed, true))).toEqual({ outcome: 'not-accepted', batches: 0 });
    expect(deposits(closed)).toBe(0);
    const open = poolOf();
    expect(await machineSend(deps, senderOf(open, true))).toEqual({ outcome: 'sent', batches: 1 });
    expect(await machineSend(deps, senderOf(open, true))).toEqual({ outcome: 'sent', batches: 0 });
    expect(deposits(open)).toBe(1);
    expect((await sentHashes(outbox)).has(hash)).toBe(true);
  });

  it('sends no raw copy', async () => {
    const { staged, deps, outbox } = scene('vps');
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    await hold(outbox);
    const pool = poolOf();
    await machineSend(deps, senderOf(pool, true));
    expect(pool.calls.some((call) => call.route.includes('/v1/raw'))).toBe(false);
  });

  it('leaves a refused batch unsent and reported, and goes on to the next', async () => {
    const { staged, deps, outbox } = scene('vps');
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    const first = await hold(outbox, '0000000000000001');
    await hold(outbox, '0000000000000002');
    let n = 0;
    const pool = poolOf();
    const base = senderOf(pool, true);
    const via: Sender = (request) => (request.url.pathname === '/v1/deposits' && (n += 1) === 1 ? Promise.resolve(error(422, 'closed_vocabulary')) : base(request));
    expect(await machineSend(deps, via)).toEqual({ outcome: 'sent', batches: 1 });
    expect(readFileSync(join(staged.storeDir, 'pool-send.log'), 'utf8')).toContain('refused: closed_vocabulary');
    expect((await sentHashes(outbox)).size).toBe(1);
    expect((await sentHashes(outbox)).has(first)).toBe(false);
  });

  it('stops on a revoked key: nothing is sent, nothing is deleted, and the person is told', async () => {
    const { staged, deps, outbox } = scene('vps');
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    await hold(outbox, '0000000000000001');
    await hold(outbox, '0000000000000002');
    const pool = poolOf({ answers: { 'POST /v1/deposits': error(401, 'machine_revoked') } });
    expect(await machineSend(deps, senderOf(pool, true))).toEqual({ outcome: 'refused', batches: 0 });
    expect(deposits(pool)).toBe(1);
    expect((await sentHashes(outbox)).size).toBe(0);
    expect(readdirSync(outbox, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl'))).toHaveLength(2);
    expect(existsSync(keyFile(staged.storeDir))).toBe(true);
    expect(takeNotice(staged.storeDir)).toContain('revoked');
  });
});

describe('the expiry notice', () => {
  const told = async (expiresAt: number, answers: Pool['answers'] = {}): Promise<string | undefined> => {
    const { staged, deps } = scene('vps');
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    await machineSend(deps, senderOf(poolOf({ expiresAt, answers }), true));
    return takeNotice(staged.storeDir);
  };

  it('is silent at 15 days', async () => {
    expect(await told(NOW + 15 * DAY)).toBeUndefined();
  });

  it('names the day and oars pool machines at 14 days', async () => {
    const text = await told(NOW + 14 * DAY);
    expect(text).toContain('expires on 2026-11-23');
    expect(text).toContain('oars pool machines');
  });

  it('says the key has expired when the covenant answer says it is past', async () => {
    expect(await told(NOW - DAY)).toContain('has expired');
  });

  it('says the key has expired on the machine_expired refusal', async () => {
    const text = await told(NOW + 90 * DAY, { 'GET /v1/covenant': error(401, 'machine_expired') });
    expect(text).toContain('has expired');
    expect(text).toContain('oars pool machines');
  });

  it('says the account revoked the key on the machine_revoked refusal', async () => {
    expect(await told(NOW + 90 * DAY, { 'GET /v1/covenant': error(401, 'machine_revoked') })).toContain('revoked');
  });

  it('keeps the once-a-day rule: a second run the same day leaves no new notice, the next day does', async () => {
    const { staged, deps } = scene('vps');
    writeFileSync(keyFile(staged.storeDir), `${KEY}\n`);
    const pool = poolOf({ expiresAt: NOW + 3 * DAY });
    await machineSend(deps, senderOf(pool, true));
    expect(takeNotice(staged.storeDir)).toBeDefined();
    await machineSend(deps, senderOf(pool, true));
    expect(existsSync(noticeFile(staged.storeDir))).toBe(false);
    const later = nightlyPoolDeps(deps.env, staged.runtime, '0.0.0-test', () => NOW + DAY + 1);
    await machineSend(later, senderOf(pool, true));
    expect(existsSync(noticeFile(staged.storeDir))).toBe(true);
  });

  it('drops the expiring entry when the key is then found expired or revoked', async () => {
    for (const code of ['machine_expired', 'machine_revoked']) {
      const { staged, deps } = scene('vps');
      writeFileSync(keyFile(staged.storeDir), `${KEY}
`);
      await machineSend(deps, senderOf(poolOf({ expiresAt: NOW + 3 * DAY }), true));
      const later = nightlyPoolDeps(deps.env, staged.runtime, '0.0.0-test', () => NOW + DAY + 1);
      await machineSend(later, senderOf(poolOf({ answers: { 'GET /v1/covenant': error(401, code) } }), true));
      const text = takeNotice(staged.storeDir) ?? '';
      expect(text).not.toContain('expires on');
      expect(text).toContain(code === 'machine_expired' ? 'has expired' : 'revoked');
    }
  });

  it('prints through messageOf as one message', () => {
    expect(messageOf([{ code: 'machine_key_expiring', at: NOW, expiresAt: NOW + DAY }])).toContain('expires on 2026-11-10');
  });
});
