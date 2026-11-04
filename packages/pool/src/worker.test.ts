// Runs the bundled handler and its D1 store under the Workers runtime (Miniflare's workerd), with no account, no Docker, and no network.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { startPool, stubUser, type Answer, type TestPool } from './test-pool.js';
import worker from './worker.js';

const TOKEN = 'a-test-token';
const framed = frame({ shell: 'bash' });
let pool: TestPool;

const skeleton = (): SessionSkeleton => {
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
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

  it('refuses a skeleton holding no prompt and no tool, naming transcripts, storing nothing', async () => {
    const sent = skeleton();
    const { status, json } = await post(JSON.stringify({ ...sent, transcripts: sent.transcripts.map((transcript) => ({ ...transcript, prompts: [], tools: [] })) }));
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts' });
    expect(await storedCount()).toBe(0);
  });

  it('refuses an oversized body sent with no declared length, on the bytes it read', async () => {
    const oversized = new TextEncoder().encode('x'.repeat(1024 * 1024 + 1));
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const response = await pool.miniflare.dispatchFetch('http://pool.test/v1/deposits', { method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'too_large' });
  });

  it('stores a closed skeleton once, and a redeposit replaces it', async () => {
    expect(await post(JSON.stringify(skeleton()))).toEqual({ status: 201, json: { ok: true, id: '0123456789abcdef' } });
    expect((await post(JSON.stringify(skeleton()))).status).toBe(201);
    expect(await storedCount()).toBe(1);
  });
});

describe('an oversized deposit with a declared length', () => {
  // Outside the runtime, because only a stand-in request can show its body was not read; everything past the sign-in is the same code.
  it('is refused on the header, with its body unread', async () => {
    const row = { account: 'acct-1', covenant: 'v1' };
    const db = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(row), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 0 } }) }) }), batch: () => Promise.resolve([]) };
    const request = new Request('http://pool.test/v1/deposits', { method: 'POST', body: 'x', headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(1024 * 1024 + 1) } });
    const read = (): Promise<string> => Promise.reject(new Error('the body was read'));
    Object.defineProperty(request, 'text', { value: read });
    const response = await worker.fetch(request, { DB: db, COVENANT_VERSION: 'v1' });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'too_large' });
  });
});

describe('a harness version that does not decode', () => {
  it('is a named refusal, not an uncaught error', async () => {
    expect(await pool.get('/bundle/claude-code/%E0%A4%A/0', TOKEN)).toMatchObject({ status: 400, json: { error: 'unknown_harness_version', field: 'harnessVersion' } });
    expect(await pool.get('/bundle/%E0%A4%A/2.1.314/0', TOKEN)).toMatchObject({ status: 400, json: { error: 'unknown_harness', field: 'harness' } });
  });
});

describe('deposits per account', () => {
  const signedIn = async (limited: TestPool, id: string): Promise<string> => {
    const { token } = await limited.signIn('github', stubUser(id));
    await limited.post('/v1/covenant/accept', { version: 'v1' }, token);
    return token;
  };

  it('takes deposits up to the limit, refuses the next by name, and still takes a redeposit', async () => {
    const limited = await startPool({ MAX_DEPOSITS_PER_ACCOUNT: '2' });
    try {
      const token = await signedIn(limited, '4001');
      const sent = (id: string): Promise<Answer> => limited.post('/v1/deposits', sampleSkeleton(id), token);
      expect((await sent('0000000000000001')).status).toBe(201);
      expect((await sent('0000000000000002')).status).toBe(201);
      expect(await sent('0000000000000003')).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
      expect((await sent('0000000000000002')).status).toBe(201);
      const stored = await (await limited.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count');
      expect(stored).toBe(2);
      // One account's limit is its own.
      expect((await limited.post('/v1/deposits', sampleSkeleton('0000000000000003'), await signedIn(limited, '4002'))).status).toBe(201);
    } finally {
      await limited.dispose();
    }
  }, 60_000);

  it('falls back to its default when the binding is not a positive whole number', async () => {
    const limited = await startPool({ MAX_DEPOSITS_PER_ACCOUNT: 'many' });
    try {
      const token = await signedIn(limited, '4003');
      expect((await limited.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).status).toBe(201);
      expect((await limited.post('/v1/deposits', sampleSkeleton('0000000000000002'), token)).status).toBe(201);
    } finally {
      await limited.dispose();
    }
  }, 60_000);
});

describe('a frame day in the future', () => {
  it('is refused under the runtime, naming the field, storing nothing', async () => {
    const before = await storedCount();
    const { status, json } = await post(JSON.stringify(sampleSkeleton('00000000000000f1', { languages: ['typescript'] }, '9999-12-31')));
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].frame.day' });
    expect(await storedCount()).toBe(before);
  });

  describe('against a fixed clock', () => {
    // Outside the runtime, because workerd keeps its own clock and a test reading the real one could cross midnight between the two sides.
    const send = async (sent: SessionSkeleton): Promise<Response> => {
      const row = { account: 'acct-1', covenant: 'v1' };
      const bound = { first: () => Promise.resolve(row), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 1 } }) };
      const db = { prepare: () => ({ bind: () => bound }), batch: () => Promise.resolve([{ meta: { changes: 1 } }]) };
      const request = new Request('http://pool.test/v1/deposits', { method: 'POST', body: JSON.stringify(sent), headers: { authorization: `Bearer ${TOKEN}` } });
      return worker.fetch(request, { DB: db, COVENANT_VERSION: 'v1' });
    };
    const onDay = (day: string): SessionSkeleton => sampleSkeleton('00000000000000f2', { languages: ['typescript'] }, day);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('takes tomorrow UTC, since a client clock can run a little ahead, and refuses the day after', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-03T23:59:00Z') });
      expect((await send(onDay('2026-11-04'))).status).toBe(201);
      const late = await send(onDay('2026-11-05'));
      expect(late.status).toBe(422);
      expect(await late.json()).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].frame.day' });
    });

    it("names a prompt's frame when only that one is late, and takes a frame with no day", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-03T12:00:00Z') });
      const sent = onDay('2026-11-03');
      const late = { ...sent, transcripts: sent.transcripts.map((transcript) => ({ ...transcript, prompts: transcript.prompts.map((entry) => ({ ...entry, frame: { ...entry.frame, day: '2027-01-01' } })) })) };
      const response = await send(late);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: 'closed_vocabulary', field: 'transcripts[0].prompts[0].frame.day' });
      const undated = { ...sent, transcripts: sent.transcripts.map((transcript) => ({ ...transcript, frame: { ...transcript.frame, day: null }, prompts: transcript.prompts.map((entry) => ({ ...entry, frame: { ...entry.frame, day: null } })) })) };
      expect((await send(undated)).status).toBe(201);
    });
  });
});

describe('stored bytes per account', () => {
  const sized = (id: string): number => {
    const parsed = parseSkeleton(sampleSkeleton(id));
    if (!parsed.ok) throw new Error('the sample does not parse');
    // The budget counts the batch's deltas too, which are `[]` until the wire carries them.
    return JSON.stringify(parsed.skeleton).length + '[]'.length;
  };
  const signedIn = async (limited: TestPool, id: string): Promise<string> => {
    const { token } = await limited.signIn('github', stubUser(id));
    await limited.post('/v1/covenant/accept', { version: 'v1' }, token);
    return token;
  };

  it('takes deposits up to the budget, refuses the next by name, and still takes a redeposit that fits', async () => {
    const budget = sized('0000000000000001') + sized('0000000000000002');
    const limited = await startPool({ MAX_DEPOSIT_BYTES_PER_ACCOUNT: String(budget) });
    try {
      const token = await signedIn(limited, '5001');
      const sent = (id: string): Promise<Answer> => limited.post('/v1/deposits', sampleSkeleton(id), token);
      expect((await sent('0000000000000001')).status).toBe(201);
      expect((await sent('0000000000000002')).status).toBe(201);
      expect(await sent('0000000000000003')).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
      // At the budget exactly: only a sum that leaves out the row being replaced lets this through.
      expect((await sent('0000000000000002')).status).toBe(201);
      expect(await (await limited.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(2);
      // One account's budget is its own.
      expect((await limited.post('/v1/deposits', sampleSkeleton('0000000000000003'), await signedIn(limited, '5002'))).status).toBe(201);
    } finally {
      await limited.dispose();
    }
  }, 60_000);

  it('refuses a redeposit that would grow past the budget, and keeps the row it would have replaced', async () => {
    const budget = sized('0000000000000001') + sized('0000000000000002');
    const limited = await startPool({ MAX_DEPOSIT_BYTES_PER_ACCOUNT: String(budget) });
    try {
      const token = await signedIn(limited, '5003');
      const sent = (id: string): Promise<Answer> => limited.post('/v1/deposits', sampleSkeleton(id), token);
      expect((await sent('0000000000000001')).status).toBe(201);
      expect((await sent('0000000000000002')).status).toBe(201);
      const db = await limited.db();
      // A held row grown by hand: the same deposit no longer fits beside it.
      await db.prepare("UPDATE deposits SET skeleton = skeleton || ' ' WHERE id = '0000000000000001'").run();
      expect(await sent('0000000000000002')).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(2);
    } finally {
      await limited.dispose();
    }
  }, 60_000);

  it('falls back to its default when the binding is not a positive whole number', async () => {
    const limited = await startPool({ MAX_DEPOSIT_BYTES_PER_ACCOUNT: 'many' });
    try {
      const token = await signedIn(limited, '5004');
      expect((await limited.post('/v1/deposits', sampleSkeleton('0000000000000001'), token)).status).toBe(201);
    } finally {
      await limited.dispose();
    }
  }, 60_000);
});
