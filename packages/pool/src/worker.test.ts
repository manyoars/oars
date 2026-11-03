// Runs the bundled handler and its D1 store under the Workers runtime (Miniflare's workerd), with no account, no Docker, and no network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frame, prompt, session, step, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { sessionsOf, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';

const TOKEN = 'a-test-token';
const framed = frame({ shell: 'bash' });
let pool: Miniflare;

const skeleton = (): SessionSkeleton => {
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  const [only] = sessionsOf(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef');
  if (built === null) throw new Error('no skeleton');
  return built;
};

const post = async (body: string, token: string | null = TOKEN): Promise<{ status: number; json: unknown }> => {
  const response = await pool.dispatchFetch('http://pool.test/v1/deposits', { method: 'POST', body, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  return { status: response.status, json: await response.json() };
};

const storedCount = async (): Promise<unknown> => {
  const db = await pool.getD1Database('DB');
  return db.prepare('SELECT COUNT(*) AS count FROM deposits').first('count');
};

beforeAll(async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', conditions: ['workerd', 'worker'], external: ['node:*'] });
  const contents = bundled.outputFiles[0]?.text;
  if (contents === undefined) throw new Error('the bundle is empty');
  pool = new Miniflare({ workers: [{ name: 'pool', modules: [{ type: 'ESModule', path: 'worker.js', contents }], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'pool-test' } }] });
  await pool.ready;
  const db = await pool.getD1Database('DB');
  const migration = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8');
  for (const line of migration.split('\n')) if (line.startsWith('CREATE')) await db.prepare(line).run();
  await db.prepare("INSERT INTO accounts (id) VALUES ('acct-1')").run();
  await db.prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct-1', ?)").bind(createHash('sha256').update(TOKEN).digest('hex'), Date.now() + 60_000).run();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('POST /v1/deposits, under the Workers runtime', () => {
  it('refuses a smuggled class A field and names it, storing nothing', async () => {
    const sent = skeleton();
    const body = JSON.stringify({ ...sent, transcripts: sent.transcripts.map((transcript) => ({ ...transcript, prompts: transcript.prompts.map((entry) => ({ ...entry, head: 'a private prompt' })) })) });
    const { status, json } = await post(body);
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].prompts[0].head' });
    expect(await storedCount()).toBe(0);
  });

  it('refuses a value outside the vocabulary and names it, storing nothing', async () => {
    const sent = skeleton();
    const body = JSON.stringify({ ...sent, transcripts: sent.transcripts.map((transcript) => ({ ...transcript, frame: { ...transcript.frame, model: 'acme-llm' } })) });
    const { status, json } = await post(body);
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].frame.model' });
    expect(await storedCount()).toBe(0);
  });

  it('refuses a body that is not JSON, one too large, and a caller with no account', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post('x'.repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await post(JSON.stringify(skeleton()), null)).status).toBe(401);
    expect((await post(JSON.stringify(skeleton()), 'a-wrong-token')).status).toBe(401);
    expect(await storedCount()).toBe(0);
  });

  it('stores a closed skeleton once, and a redeposit replaces it', async () => {
    expect(await post(JSON.stringify(skeleton()))).toEqual({ status: 201, json: { ok: true, id: '0123456789abcdef' } });
    expect((await post(JSON.stringify(skeleton()))).status).toBe(201);
    expect(await storedCount()).toBe(1);
  });
});
