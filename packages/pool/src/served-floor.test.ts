// Item 4 of t881: a long-tail name and a hashed host are held always and served only once `DEFAULT_PUBLIC_FLOOR` distinct accounts report the same value, and every bundle states the floor it applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBundle, VOCAB_VERSION, type Bundle } from '../../cli/src/sessions/pool-wire.js';
import { DEFAULT_PUBLIC_FLOOR } from './floors.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, startPool, stubUser, type TestPool } from './test-pool.js';

const VERSION = '2.1.314';
const LONG_TAIL = 'acme-deploy';
const HOST = 'secret.corp.example';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const signedIn = async (id: string): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token);
  return token;
};

/** A sample session whose first tool fetches a host instead of running a command. */
const fetching = (id: string, host: string): unknown => {
  const sample = sampleSkeleton(id);
  const [transcript] = sample.transcripts;
  const [tool, ...rest] = transcript?.tools ?? [];
  const [first] = tool?.steps ?? [];
  if (transcript === undefined || tool === undefined || first === undefined) throw new Error('the sample holds no step');
  return { ...sample, transcripts: [{ ...transcript, tools: [{ ...tool, steps: [{ ...first, action: 'web.fetch', native: 'WebFetch', identity: { host } }] }, ...rest] }] };
};

const fetched = async (token: string): Promise<{ bundle: Bundle; text: string }> => {
  const { status, json } = await pool.get(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
  expect(status).toBe(200);
  const verified = await verifyBundle(json, pool.pinned(), 'claude-code', VERSION);
  if (!verified.ok) throw new Error(verified.reason);
  return { bundle: verified.bundle, text: JSON.stringify(json) };
};

describe('a long-tail program', () => {
  it('is served nothing at four accounts and named at the fifth', async () => {
    const tokens: string[] = [];
    for (let at = 0; at < DEFAULT_PUBLIC_FLOOR; at += 1) {
      tokens.push(await signedIn(String(8100 + at)));
      const id = String(at + 1).padStart(16, '0');
      expect((await pool.post('/v1/deposits', sampleSkeleton(id, { languages: ['typescript'] }, '2026-11-01', 'claude-code', { program: LONG_TAIL, sub: null }), tokens[at])).status).toBe(201);
      const { text } = await fetched(tokens[0] ?? '');
      // Four accounts serve nothing that names it, in a cell, a motif, or a read; the fifth serves it.
      expect(text.includes(LONG_TAIL)).toBe(at + 1 >= DEFAULT_PUBLIC_FLOOR);
    }
  });
});

describe('every bundle states its floor', () => {
  it('names the floor applied in the signed payload', async () => {
    const token = await signedIn('8200');
    const { bundle } = await fetched(token);
    expect(bundle.floor).toBe(DEFAULT_PUBLIC_FLOOR);
  });
});

describe('a hashed host', () => {
  it('is served nothing at four accounts, only as a hash at the fifth, and never in clear', async () => {
    for (let at = 0; at < DEFAULT_PUBLIC_FLOOR; at += 1) {
      const token = await signedIn(String(8300 + at));
      expect((await pool.post('/v1/deposits', fetching(String(at + 100).padStart(16, '0'), HOST), token)).status).toBe(201);
      const { text } = await fetched(token);
      expect(text).not.toContain(HOST);
      // A hash is a hash-list value: it is held at four and served at the fifth.
      expect(/h:[0-9a-f]{64}/.test(text)).toBe(at + 1 >= DEFAULT_PUBLIC_FLOOR);
    }
  });
});

describe('differencing a total against the named values', () => {
  it('does not leave a sub-floor name as the difference between a shape and the names served beside it', async () => {
    const fresh = await startPool();
    try {
      const post = async (id: string, token: string, program: string): Promise<void> => {
        expect((await fresh.post('/v1/deposits', sampleSkeleton(id, { languages: ['typescript'] }, '2026-11-01', 'claude-code', { program, sub: null }), token)).status).toBe(201);
      };
      const tokens: string[] = [];
      for (let at = 0; at < DEFAULT_PUBLIC_FLOOR; at += 1) {
        const { token } = await fresh.signIn('github', stubUser(String(8400 + at)));
        await fresh.post('/v1/covenant/accept', acceptanceOf('v1'), token);
        tokens.push(token);
        await post(String(at + 200).padStart(16, '0'), token, 'git');
      }
      // One account alone runs a long-tail program on the same day: five accounts hold the shape, and one holds the name.
      await post('00000000000003e8', tokens[0] ?? '', LONG_TAIL);
      const { json } = await fresh.get(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, tokens[0]);
      const verified = await verifyBundle(json, fresh.pinned(), 'claude-code', VERSION);
      if (!verified.ok) throw new Error(verified.reason);
      const { cells, motifs } = verified.bundle;
      expect(JSON.stringify(verified.bundle)).not.toContain(LONG_TAIL);
      const shape = motifs.find((motif) => motif.level === 'shape' && motif.steps.length === 1 && motif.steps[0]?.action === 'shell.exec');
      const named = new Set(motifs.filter((motif) => motif.level === 'named' && motif.steps.length === 1 && motif.steps[0]?.action === 'shell.exec').map((motif) => motif.motifId));
      const dayCells = (id: string): { ok: number; failed: number }[] => cells.filter((cell) => cell.motifId === id && cell.grain === 'day' && cell.frameBucket.startsWith('claude-code/')).map(({ ok, failed }) => ({ ok, failed }));
      const total = dayCells(shape?.motifId ?? '').reduce((sum, cell) => sum + cell.ok + cell.failed, 0);
      const names = [...named].flatMap(dayCells).reduce((sum, cell) => sum + cell.ok + cell.failed, 0);
      // The shape is served with the long-tail call inside it, so a name served beside it would leave that call as the difference: the difference is zero or at least the floor's worth of calls.
      expect(total).toBeGreaterThan(0);
      expect(total - names === 0 || total - names >= DEFAULT_PUBLIC_FLOOR).toBe(true);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);
});
