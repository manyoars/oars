// `oars pool export`: the person's own copy of what the pool holds, saved to a folder (GDPR Articles 15(3) and 20). The pool is a stand-in sender that answers by route and cursor, so each test reads what the client asked for and what it kept.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer } from '../test-support.js';
import { poolExport, type Reply, type Sender } from './pool-command.js';
import type { Outgoing } from './pool-print.js';
import { signInsFile } from './pool-replica.js';
import { cleanup, settledClock, stage } from './test-support.js';

useServer();
afterEach(cleanup);

const POOL = 'https://pool.test';
const TOKEN = 'a-pool-token-for-export';
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

const answer = (status: number, body: unknown = {}): Reply => ({ status, body, headers: new Headers() });

const page = (section: string, rows: readonly object[], next: string | null): Reply => answer(200, { format: 'oars-pool-account-export', version: 1, account: 'acct_one', section, rows, next });

interface Scene {
  folder: string;
  requests: Outgoing[];
  err: string[];
  out: string[];
  run: (via: Sender, options?: { raw?: boolean }) => ReturnType<typeof poolExport>;
  cli: (...args: string[]) => Promise<ExitCode>;
  storeDir: string;
}

const scene = (signedIn = true): Scene => {
  const staged = stage();
  const h = harness({});
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  if (signedIn) {
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(signInsFile(staged.storeDir), JSON.stringify([{ server: POOL, account: 'acct_one', token: TOKEN, expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKeys: { k1: { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' } } }]));
  }
  const folder = join(staged.root, 'export');
  const requests: Outgoing[] = [];
  return {
    folder,
    requests,
    err: h.err,
    out: h.out,
    storeDir: staged.storeDir,
    run: (via, options = {}) => poolExport(h.deps, { server: POOL, out: folder, raw: options.raw === true, via: (request) => { requests.push(request); return via(request); } }),
    cli: (...args) => run(args, h.deps),
  };
};

/** The pool as a table of `path?query` to reply, `404` for the rest. */
const pool = (routes: { [route: string]: Reply }): Sender => (request) => Promise.resolve(routes[`${request.url.pathname}${request.url.search}`] ?? answer(404, { error: 'not_found', message: 'No such route.' }));

const ledgerRow = (bytes: string, tombstone: string | null = null): object => ({ key: `raw/acct_one/${sha256(bytes)}`, sha256: sha256(bytes), bytes: bytes.length, captureVersion: 'c', redactionVersion: 'r', storedAt: 1, tombstone });

const TWO_PAGES = {
  '/v1/account/export': page('account', [{ id: 'acct_one' }], 'cursor-2'),
  '/v1/account/export?cursor=cursor-2': page('deposits', [{ id: 's1' }, { id: 's2' }], null),
};

const files = (folder: string): string[] => readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort();

describe('oars pool export', () => {
  it('asks for the first page and then each cursor, with the account credential, and keeps one file a page', async () => {
    const s = scene();
    const outcome = await s.run(pool(TWO_PAGES));
    expect(s.requests.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`)).toEqual(['GET /v1/account/export', 'GET /v1/account/export?cursor=cursor-2']);
    for (const request of s.requests) expect(request.headers).toContainEqual(['authorization', `Bearer ${TOKEN}`]);
    expect(files(s.folder)).toEqual(['account-export-0001.json', 'account-export-0002.json']);
    expect(JSON.parse(readFileSync(join(s.folder, 'account-export-0002.json'), 'utf8'))).toMatchObject({ section: 'deposits', rows: [{ id: 's1' }, { id: 's2' }], next: null });
    expect(outcome.document).toMatchObject({ ok: true, server: POOL, folder: s.folder, pages: 2, rows: 3, raw: { requested: false, saved: 0, erased: 0 } });
    expect(outcome.text).toContain(s.folder);
    expect(outcome.text).toContain('2 pages');
    expect(outcome.text).toContain('3 rows');
  });

  it('keeps the files readable by the owner only', async () => {
    if (process.platform === 'win32') return;
    const s = scene();
    await s.run(pool(TWO_PAGES));
    expect(statSync(s.folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.folder, 'account-export-0001.json')).mode & 0o777).toBe(0o600);
  });

  it('over the network, prints each request first with the credential masked, and keeps the raw bytes of a download as they came', async () => {
    const s = scene();
    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x41, 0x0a]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const seen: string[] = [];
    server.use(
      http.get(`${POOL}/v1/account/export`, ({ request }) => {
        seen.push(request.headers.get('authorization') ?? '');
        return HttpResponse.json({ format: 'oars-pool-account-export', version: 1, section: 'rawLedger', rows: [{ sha256: hash, tombstone: null }], next: null });
      }),
      http.get(`${POOL}/v1/account/export/raw/:hash`, ({ request }) => {
        seen.push(request.headers.get('authorization') ?? '');
        return new HttpResponse(bytes, { headers: { 'content-type': 'application/octet-stream' } });
      }),
    );
    expect(await s.cli('pool', 'export', '--out', s.folder, '--server', POOL, '--raw')).toBe(ExitCode.OK);
    expect(seen).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    const printed = s.err.join('');
    expect(printed).toContain('GET /v1/account/export');
    expect(printed).toContain(`GET /v1/account/export/raw/${hash}`);
    expect(printed).not.toContain(TOKEN);
    expect(readFileSync(join(s.folder, 'raw', hash))).toEqual(bytes);
  });

  it('over the network, reads a refused download as the pool\'s JSON refusal', async () => {
    const s = scene();
    const hash = sha256('refused');
    server.use(
      http.get(`${POOL}/v1/account/export`, () => HttpResponse.json({ format: 'oars-pool-account-export', version: 1, section: 'rawLedger', rows: [{ sha256: hash, tombstone: null }], next: null })),
      http.get(`${POOL}/v1/account/export/raw/:hash`, () => HttpResponse.json({ error: 'erased', message: 'This raw object was erased.' }, { status: 410 })),
    );
    expect(await s.cli('pool', 'export', '--out', s.folder, '--server', POOL, '--raw')).toBe(ExitCode.UNEXPECTED);
    expect(s.err.join('')).toContain('HTTP 410: This raw object was erased.');
  });

  it('names a ledger row that carries no SHA-256, and still saves the page', async () => {
    const s = scene();
    const refused: unknown = await s.run(pool({ '/v1/account/export': page('rawLedger', [{ tombstone: null }], null) })).catch((error: unknown) => error);
    expect(refused instanceof Error ? refused.message : '').toContain('page 1 lists a raw object with no SHA-256');
    expect(existsSync(join(s.folder, 'account-export-0001.json'))).toBe(true);
  });

  it('refuses a person who is not signed in, before it asks the pool anything', async () => {
    const s = scene(false);
    await expect(s.run(pool(TWO_PAGES))).rejects.toMatchObject({ exitCode: ExitCode.AUTH });
    expect(s.requests).toEqual([]);
    expect(existsSync(s.folder)).toBe(false);
  });

  it('fetches no raw object without --raw, and says how many the ledger lists', async () => {
    const s = scene();
    const outcome = await s.run(pool({ '/v1/account/export': page('rawLedger', [ledgerRow('one'), ledgerRow('two', '2026-11-02')], null) }));
    expect(s.requests).toHaveLength(1);
    expect(outcome.text).toContain('--raw');
    expect(outcome.document).toMatchObject({ raw: { requested: false, saved: 0 } });
  });

  it('hints at --raw only when some ledger object stands', async () => {
    const standing = await scene().run(pool({ '/v1/account/export': page('rawLedger', [ledgerRow('kept bytes')], null) }));
    expect(standing.text).toContain('run again with --raw');
    const gone = await scene().run(pool({ '/v1/account/export': page('rawLedger', [ledgerRow('gone bytes', '2026-11-02')], null) }));
    expect(gone.text).not.toContain('--raw');
  });

  it('with --raw removes a raw file the ledger no longer lists as standing, and leaves other files alone', async () => {
    const s = scene();
    const kept = 'kept bytes';
    const gone = 'since erased';
    const both = pool({
      '/v1/account/export': page('rawLedger', [ledgerRow(kept), ledgerRow(gone)], null),
      [`/v1/account/export/raw/${sha256(kept)}`]: answer(200, Buffer.from(kept)),
      [`/v1/account/export/raw/${sha256(gone)}`]: answer(200, Buffer.from(gone)),
    });
    await s.run(both, { raw: true });
    writeFileSync(join(s.folder, 'raw', 'notes.txt'), 'mine');
    expect(existsSync(join(s.folder, 'raw', sha256(gone)))).toBe(true);
    // The pool has since erased the second object: a rerun must not leave its copy looking current.
    await s.run(pool({ '/v1/account/export': page('rawLedger', [ledgerRow(kept), ledgerRow(gone, '2026-11-08')], null), [`/v1/account/export/raw/${sha256(kept)}`]: answer(200, Buffer.from(kept)) }), { raw: true });
    expect(existsSync(join(s.folder, 'raw', sha256(gone)))).toBe(false);
    expect(readFileSync(join(s.folder, 'raw', sha256(kept)), 'utf8')).toBe(kept);
    expect(existsSync(join(s.folder, 'raw', 'notes.txt'))).toBe(true);
  });

  it('with --raw fetches each ledger object that stands, checks its hash, and keeps its bytes as sent', async () => {
    const s = scene();
    const bytes = 'a redacted line\nand another\n';
    const outcome = await s.run(
      pool({
        '/v1/account/export': page('rawLedger', [ledgerRow(bytes), ledgerRow('erased bytes', '2026-11-02')], null),
        [`/v1/account/export/raw/${sha256(bytes)}`]: answer(200, Buffer.from(bytes)),
      }),
      { raw: true },
    );
    expect(s.requests.map((request) => request.url.pathname)).toEqual(['/v1/account/export', `/v1/account/export/raw/${sha256(bytes)}`]);
    expect(readFileSync(join(s.folder, 'raw', sha256(bytes)), 'utf8')).toBe(bytes);
    expect(existsSync(join(s.folder, 'raw', sha256('erased bytes')))).toBe(false);
    expect(outcome.document).toMatchObject({ raw: { requested: true, saved: 1, erased: 1 } });
    if (process.platform !== 'win32') expect(statSync(join(s.folder, 'raw', sha256(bytes))).mode & 0o777).toBe(0o600);
  });

  it('keeps bytes that are not UTF-8 exactly as they came', async () => {
    const s = scene();
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0xc3]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await s.run(pool({ '/v1/account/export': page('rawLedger', [{ key: `raw/acct_one/${hash}`, sha256: hash, tombstone: null }], null), [`/v1/account/export/raw/${hash}`]: answer(200, bytes) }), { raw: true });
    expect(readFileSync(join(s.folder, 'raw', hash))).toEqual(bytes);
  });

  it('names a raw object that failed, finishes the others, and exits nonzero with what it saved', async () => {
    const s = scene();
    const [good, gone] = ['kept bytes', 'missing bytes'];
    const failed = s.run(
      pool({
        '/v1/account/export': page('rawLedger', [ledgerRow(gone), ledgerRow(good)], null),
        [`/v1/account/export/raw/${sha256(gone)}`]: answer(404, { error: 'not_found', message: 'This account holds no raw object with this hash.' }),
        [`/v1/account/export/raw/${sha256(good)}`]: answer(200, Buffer.from(good)),
      }),
      { raw: true },
    );
    const refused: unknown = await failed.catch((error: unknown) => error);
    expect(refused).toMatchObject({ exitCode: ExitCode.UNEXPECTED });
    const message = refused instanceof Error ? refused.message : '';
    expect(message).toContain(`raw object ${sha256(gone)}`);
    expect(message).toContain('404');
    expect(message).not.toContain(`raw object ${sha256(good)}`);
    expect(message).toContain('1 page');
    expect(message).toContain('1 raw object');
    expect(readFileSync(join(s.folder, 'raw', sha256(good)), 'utf8')).toBe(good);
    expect(existsSync(join(s.folder, 'raw', sha256(gone)))).toBe(false);
  });

  it('refuses bytes that do not hash to the name the ledger gave, and keeps none of them', async () => {
    const s = scene();
    const hash = sha256('what the ledger says');
    const refused: unknown = await s.run(pool({ '/v1/account/export': page('rawLedger', [{ sha256: hash, tombstone: null }], null), [`/v1/account/export/raw/${hash}`]: answer(200, Buffer.from('something else')) }), { raw: true }).catch((error: unknown) => error);
    expect(refused instanceof Error ? refused.message : '').toContain(`raw object ${hash}`);
    expect(refused).toMatchObject({ problem: { code: 'raw_unverified' } });
    expect(existsSync(join(s.folder, 'raw', hash))).toBe(false);
  });

  it('names a raw object whose answer carries no bytes', async () => {
    const s = scene();
    const hash = sha256('empty answer');
    const refused: unknown = await s.run(pool({ '/v1/account/export': page('rawLedger', [{ sha256: hash, tombstone: null }], null), [`/v1/account/export/raw/${hash}`]: answer(200, undefined) }), { raw: true }).catch((error: unknown) => error);
    expect(refused instanceof Error ? refused.message : '').toContain(`raw object ${hash}`);
  });

  it('names the page that failed, stops there, and keeps the pages before it', async () => {
    const s = scene();
    const refused: unknown = await s.run(pool({ ...TWO_PAGES, '/v1/account/export?cursor=cursor-2': answer(500, { error: 'boom', message: 'The pool broke.' }) })).catch((error: unknown) => error);
    expect(refused).toMatchObject({ problem: { status: 500 } });
    expect(refused instanceof Error ? refused.message : '').toContain('page 2');
    expect(files(s.folder)).toEqual(['account-export-0001.json']);
  });

  it('exits as a sign-in failure when the pool refuses the credential on the first page', async () => {
    const s = scene();
    await expect(s.run(pool({ '/v1/account/export': answer(401, { error: 'unauthorized', message: 'Sign in with oars pool login first.' }) }))).rejects.toMatchObject({ exitCode: ExitCode.AUTH });
  });

  it.each([
    ['an answer that is not JSON', answer(200, undefined)],
    ['a different format', answer(200, { format: 'something-else', version: 1, rows: [], next: null })],
    ['a newer version than this client reads', answer(200, { format: 'oars-pool-account-export', version: 2, rows: [], next: null })],
    ['a page with no rows', answer(200, { format: 'oars-pool-account-export', version: 1, next: null })],
    ['a cursor that is not text', answer(200, { format: 'oars-pool-account-export', version: 1, rows: [], next: 5 })],
  ])('refuses %s as a failed page, and keeps nothing for it', async (_label, reply) => {
    const s = scene();
    const refused: unknown = await s.run(pool({ '/v1/account/export': reply })).catch((error: unknown) => error);
    expect(refused instanceof Error ? refused.message : '').toContain('page 1');
    expect(existsSync(join(s.folder, 'account-export-0001.json'))).toBe(false);
  });

  it('stops at a cursor the pool repeats and names the page', async () => {
    const s = scene();
    const refused: unknown = await s.run(pool({ '/v1/account/export': page('account', [], 'loop'), '/v1/account/export?cursor=loop': page('account', [], 'loop') })).catch((error: unknown) => error);
    expect(refused instanceof Error ? refused.message : '').toContain('page 2');
  });

  it('overwrites the same files on a rerun and removes pages a shorter export no longer has', async () => {
    const s = scene();
    await s.run(pool(TWO_PAGES), {});
    writeFileSync(join(s.folder, 'unrelated.txt'), 'mine');
    await s.run(pool({ '/v1/account/export': page('account', [{ id: 'acct_one', changed: true }], null) }));
    expect(files(s.folder)).toEqual(['account-export-0001.json', 'unrelated.txt']);
    expect(JSON.parse(readFileSync(join(s.folder, 'account-export-0001.json'), 'utf8'))).toMatchObject({ rows: [{ changed: true }] });
  });

  it('is reachable as oars pool export --out <folder>, and states a missing folder as a usage error', async () => {
    const s = scene(false);
    expect(await s.cli('pool', 'export')).toBe(ExitCode.USAGE);
    expect(await s.cli('pool', 'export', '--out', s.folder, '--server', POOL)).toBe(ExitCode.AUTH);
  });
});
