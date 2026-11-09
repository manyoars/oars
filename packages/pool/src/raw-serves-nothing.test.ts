// The raw tier serves nothing in v1: a guard over the pool's source and its route table, the way ledger.test.ts guards deletes. Only the upload touches the raw bucket or its ledger table,
// and no route returns a raw byte, a hash, or a count per account. A later layer that serves raw needs a new brief and a change to this file.
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RAW_ROUTES } from './raw.js';
import { acceptanceOf, fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const here = (relative: string): URL => new URL(relative, import.meta.url);

/** Source text with its comments removed, so prose that names the binding is not a use of it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const keysOf = (value: unknown): string[] => (typeof value === 'object' && value !== null ? Object.keys(value).sort() : []);

const RAW_HOME = 'raw.ts';
/** Names that reach raw state: the R2 binding, the ledger table, the consent column, and the staging keys. */
const RAW_STATE = /\bRAW\b|raw_objects|raw_consent|staging\//;
/** What `raw.ts` may call on the bucket: it writes staged parts, reads them back to assemble, assembles through a multipart upload, and removes its own staged parts. It lists one account's own staging prefix to bound it (S12), and uses the keys only to refuse a part; it never heads. */
const BUCKET_CALLS = new Set(['put', 'get', 'delete', 'list', 'createMultipartUpload']);
/** The only keys an answer in `raw.ts` may carry: no byte, no hash, no count of what an account holds. */
const ANSWER_KEYS = new Set(['ok', 'stored', 'part']);

/** What in `files` (name to text) would let the raw tier serve, or let another file reach it. */
const offences = (files: { [name: string]: string }): string[] =>
  Object.entries(files).flatMap(([name, text]) => {
    const body = code(text);
    if (basename(name) !== RAW_HOME) {
      // `http.ts` declares the optional binding and its types; nothing else may name raw state.
      const declaresOnly = basename(name) === 'http.ts' && body.replace(/\bRAW\?: RawBucket;/, '').search(RAW_STATE) === -1;
      return RAW_STATE.test(body) && !declaresOnly ? [`${name}: touches raw state outside raw.ts`] : [];
    }
    const calls = [...body.matchAll(/\bbucket\.(\w+)\(/g)].map(([, method]) => method ?? '');
    const answerKeys = [...body.matchAll(/\banswer\(\s*\d+\s*,\s*\{([^}]*)\}/g)].flatMap(([, keys]) => [...(keys ?? '').matchAll(/(\w+)\s*:/g)].map(([, key]) => key ?? ''));
    return [
      ...calls.filter((method) => !BUCKET_CALLS.has(method)).map((method) => `${name}: calls bucket.${method}`),
      ...(calls.filter((method) => method === 'get').length > 1 ? [`${name}: more than one bucket.get`] : []),
      ...(/\bnew Response\(/.test(body) ? [`${name}: builds a Response of its own`] : []),
      ...answerKeys.filter((key) => !ANSWER_KEYS.has(key)).map((key) => `${name}: answers with ${key}`),
    ];
  });

const sourceFiles = (): { [name: string]: string } =>
  Object.fromEntries(
    readdirSync(fileURLToPath(here('.')), { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll(String.fromCharCode(92), '/'))
      .filter((file) => file.endsWith('.ts') && !basename(file).endsWith('.test.ts') && basename(file) !== 'test-pool.ts')
      .map((file) => [`src/${file}`, readFileSync(here(file), 'utf8')]),
  );

describe('the raw tier is reachable from the upload only', () => {
  it('finds raw state only in raw.ts, and the bucket used only to stage, assemble, and clean up', () => {
    const files = sourceFiles();
    // Check the scan reached the files that serve: derive, stored, bundle, and the route table.
    for (const name of ['src/raw.ts', 'src/derive.ts', 'src/stored.ts', 'src/bundle.ts', 'src/worker.ts', 'src/http.ts']) expect(Object.keys(files), name).toContain(name);
    expect(offences(files)).toEqual([]);
  });

  it('names the route table: one PUT for a part and one POST to complete, and nothing that reads', () => {
    expect(RAW_ROUTES.map(({ method, pattern }) => `${method} ${pattern.source}`)).toEqual([
      'PUT ^\\/v1\\/raw\\/([0-9a-f]{64})\\/parts\\/([1-9][0-9]{0,5})$',
      'POST ^\\/v1\\/raw\\/([0-9a-f]{64})\\/complete$',
    ]);
    const worker = code(readFileSync(here('./worker.ts'), 'utf8'));
    expect(worker.match(/rawRoute\(/g)).toHaveLength(1);
    expect(worker).not.toMatch(/\/v1\/raw/);
  });

  // One row per planted case, so each fails on its own when its rule is missing.
  it.each([
    ['derive.ts reading the ledger table', { 'src/derive.ts': 'await env.DB.prepare("SELECT COUNT(*) FROM raw_objects")' }, 'src/derive.ts: touches raw state outside raw.ts'],
    ['stored.ts reading the bucket', { 'src/stored.ts': 'const object = await env.RAW.get(key)' }, 'src/stored.ts: touches raw state outside raw.ts'],
    ['bundle.ts reading the consent', { 'src/bundle.ts': 'SELECT raw_consent FROM accounts' }, 'src/bundle.ts: touches raw state outside raw.ts'],
    ['http.ts naming the binding twice', { 'src/http.ts': 'RAW?: RawBucket;\nconst served = env.RAW;' }, 'src/http.ts: touches raw state outside raw.ts'],
    ['raw.ts heading an object', { 'src/raw.ts': 'await bucket.head(key)' }, 'src/raw.ts: calls bucket.head'],
    ['raw.ts reading a second object', { 'src/raw.ts': 'await bucket.get(a); await bucket.get(b);' }, 'src/raw.ts: more than one bucket.get'],
    ['raw.ts answering with a Response', { 'src/raw.ts': 'return new Response(stored.body)' }, 'src/raw.ts: builds a Response of its own'],
    ['raw.ts answering with a count', { 'src/raw.ts': "return answer(200, { ok: true, bytes: held })" }, 'src/raw.ts: answers with bytes'],
    ['raw.ts answering with a hash', { 'src/raw.ts': "return answer(200, {\n sha256: hash })" }, 'src/raw.ts: answers with sha256'],
  ])('names %s', (_label, files, offence) => {
    expect(offences(files)).toEqual([offence]);
  });

  it('lets raw.ts stage, assemble, list its staging prefix, and answer ok', () => {
    const text = 'await bucket.put(k, b); const s = await bucket.get(k); await bucket.createMultipartUpload(k); await bucket.delete(ks); await bucket.list({ prefix }); return answer(201, { ok: true, stored: true });';
    expect(offences({ 'src/raw.ts': text })).toEqual([]);
    expect(offences({ 'src/other.ts': '// the RAW bucket is raw.ts\'s: raw_objects' })).toEqual([]);
  });
});

describe('no route serves a raw byte, a hash, or a count', () => {
  let pool: TestPool;
  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);
  afterAll(async () => {
    await pool.dispose();
  });

  it('answers 404 to every method on every raw path but the two uploads, and puts no stored byte in any answer', async () => {
    const { token } = await pool.signIn('github', stubUser('8801'));
    await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token);
    const marker = 'SERVE-MARKER-must-never-come-back';
    const bytes = new TextEncoder().encode(marker.repeat(10));
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const headers = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-1', 'oars-raw-consent': 'granted', 'oars-raw-consent-version': 'v1' };
    const part = await pool.send(`/v1/raw/${hash}/parts/1`, { method: 'PUT', body: bytes }, token, headers);
    const done = await pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: bytes.length }) }, token, headers);
    expect([part.status, done.status]).toEqual([200, 201]);
    // The uploads answer ok and nothing else: no hash back, no size, no count.
    expect(keysOf(part.json)).toEqual(['ok', 'part']);
    expect(keysOf(done.json)).toEqual(['ok', 'stored']);

    const paths = ['/v1/raw', `/v1/raw/${hash}`, `/v1/raw/${hash}/parts/1`, `/v1/raw/${hash}/complete`, `/v1/raw/${hash}/object`, `/v1/raw/${hash}/count`, '/v1/raw/count', '/v1/raw/me', `/raw/${hash}`, `/v1/me/raw`, '/v1/raw/', `/v1/raw/${hash}/parts`];
    const uploads = new Set([`PUT /v1/raw/${hash}/parts/1`, `POST /v1/raw/${hash}/complete`]);
    for (const path of paths) {
      for (const method of ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS']) {
        if (uploads.has(`${method} ${path}`)) continue;
        // Read the body as text and never parse it: a route that served the stored bytes as plain text must fail here, not throw and be skipped. HEAD answers an empty body, so it reads too.
        const sent = await pool.miniflare.dispatchFetch(`http://pool.test${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...headers },
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
        });
        const text = await sent.text();
        expect(sent.status, `${method} ${path}`).toBe(404);
        expect(text, `${method} ${path}`).not.toContain(marker);
      }
    }
    // The routes that do answer carry no raw figure: the covenant status is its three fields.
    const status = await pool.get('/v1/covenant', token);
    expect(keysOf(status.json)).toEqual(['accepted', 'screen', 'version']);
    expect(fieldOf(status.json, 'accepted')).toBe(true);
  }, 60_000);
});
