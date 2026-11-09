// Machine keys: the table a machine's key is kept in, and the routes that enroll, activate, rotate, list, and revoke one.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { createMachine, TOKEN_LIFE_MS } from './machines.js';
import { fieldOf, poolDbOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('the machines table', () => {
  it('holds the key hash, account, label, host class, launcher, allow list, state, expiry, and fingerprint hash, and what the routes need beside them', async () => {
    const columns = (await (await pool.db()).prepare('PRAGMA table_info(machines)').all()).results.map((column) => textOf(column, 'name'));
    expect(columns.sort()).toEqual(
      ['account', 'activated_at', 'allow_repos', 'created_at', 'expires_at', 'fingerprint_hash', 'host_class', 'id', 'key_hash', 'label', 'launcher', 'retired_hash', 'rotated_at', 'state'].sort(),
    );
  });

  it('stores the hash of the enrollment token and not the token', async () => {
    const { account } = await pool.signIn('github', stubUser('4301'));
    const db = await pool.db();
    const before = Date.now();
    const env: Env = { DB: poolDbOf(db) };
    const made = await createMachine(env, account, { label: 'build box', hostClass: 'vps', launcher: 'scheduled', allowRepos: ['acme/api'] }, before);
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(made.id).first();
    expect(row).toMatchObject({ id: made.id, account, key_hash: sha256(made.token), retired_hash: null, label: 'build box', host_class: 'vps', launcher: 'scheduled', allow_repos: '["acme/api"]', state: 'pending', expires_at: before + TOKEN_LIFE_MS, fingerprint_hash: null, activated_at: null, rotated_at: null });
    // Nothing in the row, the table, or its index holds the token itself.
    for (const value of Object.values(row ?? {})) expect(String(value)).not.toContain(made.token);
    expect(fieldOf(row, 'key_hash')).not.toBe(made.token);
  });
});
