// Runs the bundled handler and its D1 store under the Workers runtime (Miniflare's workerd), with no account, no Docker, and no network.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frame, prompt, session, step, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { sessionsOf, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { startPool, type Answer, type TestPool } from './test-pool.js';

const TOKEN = 'a-test-token';
const framed = frame({ shell: 'bash' });
let pool: TestPool;

const skeleton = (): SessionSkeleton => {
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  const [only] = sessionsOf(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef');
  if (built === null) throw new Error('no skeleton');
  return built;
};

const post = (body: string, token: string | undefined = TOKEN): Promise<Answer> => pool.post('/v1/deposits', body, token);

const storedCount = async (): Promise<unknown> => (await pool.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count');

beforeAll(async () => {
  pool = await startPool();
  const db = await pool.db();
  await db.prepare("INSERT INTO accounts (id, covenant) VALUES ('acct-1', 'v1')").run();
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
    expect((await pool.post('/v1/deposits', JSON.stringify(skeleton()))).status).toBe(401);
    expect((await post(JSON.stringify(skeleton()), 'a-wrong-token')).status).toBe(401);
    expect(await storedCount()).toBe(0);
  });

  it('stores a closed skeleton once, and a redeposit replaces it', async () => {
    expect(await post(JSON.stringify(skeleton()))).toEqual({ status: 201, json: { ok: true, id: '0123456789abcdef' } });
    expect((await post(JSON.stringify(skeleton()))).status).toBe(201);
    expect(await storedCount()).toBe(1);
  });
});
