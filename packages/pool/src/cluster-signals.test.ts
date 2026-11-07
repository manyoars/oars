// Item 2 of t937: the pool stores the cluster signals it can, from data it already receives, and serves none of them.
import { describe, expect, it } from 'vitest';
import { verifyBundle, VOCAB_VERSION, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { repoKeysOf } from './cluster-store.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const KEY_A = '0123456789abcdef';
const KEY_B = 'fedcba9876543210';

/** The sample batch with its frames stating a repository. */
const withRepoKey = (skeleton: SessionSkeleton, repoKey: string): SessionSkeleton => ({
  ...skeleton,
  transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, frame: { ...transcript.frame, repoKey }, frames: transcript.frames.map((frame) => ({ ...frame, repoKey })) })),
});

const inFreshPool = async (run: (target: TestPool) => Promise<void>): Promise<void> => {
  const target = await startPool();
  try {
    await run(target);
  } finally {
    await target.dispose();
  }
};

const rowOf = async (target: TestPool, sql: string, ...values: (string | number)[]): Promise<unknown> => (await target.db()).prepare(sql).bind(...values).first();

const VERSION = '2.1.314';

/** The bundle a signed-in account fetches, verified. */
const fetched = async (target: TestPool, token: string): Promise<{ reads: number; cells: number; clusters: number[] }> => {
  const response = await target.raw(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
  expect(response.status).toBe(200);
  const verified = await verifyBundle(response.json, target.signingKey(), 'claude-code', VERSION);
  if (!verified.ok) throw new Error(verified.reason);
  return { reads: verified.bundle.reads.length, cells: verified.bundle.cells.length, clusters: verified.bundle.reads.map((read) => read.clusters) };
};

/** An account that deposits one session per repo key: `keys` of them, so its repo-key set is `keys`. The same sessions go in whatever the account, so they are the same cells. */
const depositor = async (target: TestPool, id: string, keys: readonly string[]): Promise<string> => {
  const { token } = await target.signIn('github', stubUser(id));
  await target.post('/v1/covenant/accept', { version: 'v1' }, token);
  for (const [at, key] of keys.entries()) {
    expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton(`${String(at)}${id}`.padStart(16, '0')), key), token)).status).toBe(201);
  }
  return token;
};

const heldClusters = async (target: TestPool): Promise<number[]> => [...new Set((await (await target.db()).prepare('SELECT clusters FROM cells WHERE sessions > 0').all()).results.map((row) => Number(fieldOf(row, 'clusters'))))];

describe('the count a floor compares', () => {
  it('does not clear PUBLIC_FLOOR 5 for six accounts that share a machine’s repo keys, which five accounts counted before', async () => {
    await inFreshPool(async (target) => {
      const shared = ['00000000000000a1', '00000000000000a2', '00000000000000a3'];
      const tokens: string[] = [];
      for (const id of ['9301', '9302', '9303', '9304', '9305', '9306']) tokens.push(await depositor(target, id, shared));
      expect(await heldClusters(target)).toEqual([1]);
      // The count before this change: distinct accounts holding each cell, at or above the floor of 5.
      const accountsPerCell = (await (await target.db()).prepare("SELECT COUNT(DISTINCT account) AS accounts FROM contributors WHERE kind = 'cell' GROUP BY key").all()).results.map((row) => Number(fieldOf(row, 'accounts')));
      expect(accountsPerCell.length).toBeGreaterThan(0);
      expect(accountsPerCell.every((accounts) => accounts === 6)).toBe(true);
      expect(await fetched(target, tokens[0] ?? '')).toEqual({ reads: 0, cells: 0, clusters: [] });
      // Nothing was refused: every account's deposits are held.
      expect(await (await target.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(18);
    });
  }, 180_000);

  it('still clears PUBLIC_FLOOR 5 for five unrelated accounts, and states 5 on every read', async () => {
    await inFreshPool(async (target) => {
      const tokens: string[] = [];
      for (const id of ['9311', '9312', '9313', '9314', '9315']) tokens.push(await depositor(target, id, [id.padStart(16, 'b')]));
      expect(await heldClusters(target)).toEqual([5]);
      const { reads, clusters } = await fetched(target, tokens[0] ?? '');
      expect(reads).toBeGreaterThan(0);
      expect(clusters).toHaveLength(reads);
      expect(clusters.every((count) => count === 5)).toBe(true);
    });
  }, 180_000);
});

describe('a deposit that joins an account to another', () => {
  it('recounts the cells the account already held: five accounts that cleared a cell with distinct keys then share eight keys elsewhere (their sets overlap at 0.8), and the cell reads 1', async () => {
    await inFreshPool(async (target) => {
      const tokens: string[] = [];
      for (const id of ['9321', '9322', '9323', '9324', '9325']) tokens.push(await depositor(target, id, [id.padStart(16, 'c')]));
      expect(await heldClusters(target)).toEqual([5]);
      // Each account's set is its own key and these eight: Jaccard 8 / 10 = 0.8, the threshold.
      const shared = Array.from({ length: 8 }, (_, at) => `00000000000000d${String(at)}`);
      // A session in another cell (a different stack), so the batch itself never touches the cell the five cleared.
      for (const [at, token] of tokens.entries()) {
        for (const [which, key] of shared.entries()) expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton(`${String(at)}${String(which)}`.padStart(16, 'e'), { languages: ['rust'] }, '2026-11-02', 'cursor', { program: 'git', sub: 'commit' }, '3.0.0'), key), token)).status).toBe(201);
      }
      expect(await heldClusters(target)).toEqual([1]);
    });
  }, 180_000);
});

describe('provider account age', () => {
  it('stores GitHub’s created_at as the account’s provider age, and the pool’s first sight beside it', async () => {
    await inFreshPool(async (target) => {
      const before = Date.now();
      const { account } = await target.signIn('github', { ...stubUser('9101'), createdAt: '2019-03-04T05:06:07Z' });
      const row = await rowOf(target, 'SELECT first_seen, provider_created FROM accounts WHERE id = ?', account);
      expect(fieldOf(row, 'provider_created')).toBe(Date.UTC(2019, 2, 4, 5, 6, 7));
      expect(Number(fieldOf(row, 'first_seen'))).toBeGreaterThanOrEqual(before);
    });
  }, 60_000);

  it('stores no provider age for Google, which states none, and keeps the first-seen time through a later sign-in', async () => {
    await inFreshPool(async (target) => {
      const { account } = await target.signIn('google', stubUser('9102'));
      const first = await rowOf(target, 'SELECT first_seen, provider_created FROM accounts WHERE id = ?', account);
      expect(fieldOf(first, 'provider_created')).toBeNull();
      expect(typeof fieldOf(first, 'first_seen')).toBe('number');
      await (await target.db()).prepare('UPDATE accounts SET first_seen = 1000').run();
      await target.signIn('google', stubUser('9102'));
      expect(await rowOf(target, 'SELECT first_seen FROM accounts WHERE id = ?', account)).toEqual({ first_seen: 1000 });
    });
  }, 60_000);

  it('records a provider age on a later sign-in that carries one, and keeps it through one that does not', async () => {
    await inFreshPool(async (target) => {
      const { account } = await target.signIn('github', { id: '9103', login: 'login-of-9103', email: 'person-9103@example.test' });
      expect(fieldOf(await rowOf(target, 'SELECT provider_created FROM accounts WHERE id = ?', account), 'provider_created')).toBeNull();
      await target.signIn('github', { ...stubUser('9103'), createdAt: '2018-01-02T00:00:00Z' });
      await target.signIn('github', { ...stubUser('9103'), createdAt: 'not a date' });
      expect(fieldOf(await rowOf(target, 'SELECT provider_created FROM accounts WHERE id = ?', account), 'provider_created')).toBe(Date.UTC(2018, 0, 2));
    });
  }, 60_000);
});

describe('deposit signals', () => {
  it('reads the distinct repo keys a batch’s frames carry, and none from a batch whose repository is unknown', () => {
    expect(repoKeysOf(withRepoKey(sampleSkeleton('0000000000009201'), KEY_A))).toEqual([KEY_A]);
    expect(repoKeysOf(sampleSkeleton('0000000000009202'))).toEqual([]);
  });

  it('writes the repo keys and the hour a deposit arrived, once however often it is sent', async () => {
    await inFreshPool(async (target) => {
      const { token, account } = await target.signIn('github', stubUser('9203'));
      await target.post('/v1/covenant/accept', { version: 'v1' }, token);
      const db = await target.db();
      const dayBefore = new Date().toISOString().slice(0, 10);
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009203'), KEY_A), token)).status).toBe(201);
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009204'), KEY_B), token)).status).toBe(201);
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009204'), KEY_B), token)).status).toBe(201);
      const keys = (await db.prepare('SELECT repo_key FROM account_repo_keys WHERE account = ? ORDER BY repo_key').bind(account).all()).results.map((row) => fieldOf(row, 'repo_key'));
      expect(keys).toEqual([KEY_A, KEY_B]);
      const hours = (await db.prepare('SELECT day, hour FROM deposit_hours WHERE account = ?').bind(account).all()).results;
      expect(hours).toHaveLength(1);
      // A run that crosses UTC midnight stores either day.
      expect([dayBefore, new Date().toISOString().slice(0, 10)]).toContain(fieldOf(hours[0], 'day'));
      expect(Number(fieldOf(hours[0], 'hour'))).toBeGreaterThanOrEqual(0);
    });
  }, 60_000);

  it('writes nothing for a deposit the pool refuses through an operator brake', async () => {
    const target = await startPool({ COVENANT_VERSION: 'v1', MAX_DEPOSITS_PER_ACCOUNT: '1' });
    try {
      const { token } = await target.signIn('github', stubUser('9205'));
      await target.post('/v1/covenant/accept', { version: 'v1' }, token);
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009205'), KEY_A), token)).status).toBe(201);
      const db = await target.db();
      // Cleared after the first deposit, so a row here can only come from the refused one (its hour is the same as the first's).
      await db.prepare('DELETE FROM account_repo_keys').run();
      await db.prepare('DELETE FROM deposit_hours').run();
      expect(await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009206'), KEY_B), token)).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
      expect(await db.prepare('SELECT COUNT(*) AS count FROM account_repo_keys').first('count')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM deposit_hours').first('count')).toBe(0);
    } finally {
      await target.dispose();
    }
  }, 60_000);
});
