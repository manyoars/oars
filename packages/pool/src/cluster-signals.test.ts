// Item 2 of t937: the pool stores the cluster signals it can, from data it already receives, and serves none of them.
import { describe, expect, it } from 'vitest';
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
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
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009203'), KEY_A), token)).status).toBe(201);
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009204'), KEY_B), token)).status).toBe(201);
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009204'), KEY_B), token)).status).toBe(201);
      const keys = (await db.prepare('SELECT repo_key FROM account_repo_keys WHERE account = ? ORDER BY repo_key').bind(account).all()).results.map((row) => fieldOf(row, 'repo_key'));
      expect(keys).toEqual([KEY_A, KEY_B]);
      const hours = (await db.prepare('SELECT day, hour FROM deposit_hours WHERE account = ?').bind(account).all()).results;
      expect(hours).toHaveLength(1);
      expect(fieldOf(hours[0], 'day')).toBe(new Date().toISOString().slice(0, 10));
      expect(Number(fieldOf(hours[0], 'hour'))).toBeGreaterThanOrEqual(0);
    });
  }, 60_000);

  it('writes nothing for a deposit the pool refuses', async () => {
    await inFreshPool(async (target) => {
      const { token } = await target.signIn('github', stubUser('9205'));
      expect((await target.post('/v1/deposits', withRepoKey(sampleSkeleton('0000000000009205'), KEY_A), token)).status).not.toBe(201);
      const db = await target.db();
      expect(await db.prepare('SELECT COUNT(*) AS count FROM account_repo_keys').first('count')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM deposit_hours').first('count')).toBe(0);
    });
  }, 60_000);
});
