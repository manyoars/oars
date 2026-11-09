// Machine keys: the table a machine's key is kept in, and the routes that enroll, activate, rotate, list, and revoke one.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { createMachine, TOKEN_LIFE_MS } from './machines.js';
import { anyNumber, anyText, fieldOf, matching, poolDbOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

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
    const row = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(made.machine.id).first();
    expect(row).toMatchObject({ id: made.machine.id, account, key_hash: sha256(made.token), retired_hash: null, label: 'build box', host_class: 'vps', launcher: 'scheduled', allow_repos: '["acme/api"]', state: 'pending', expires_at: before + TOKEN_LIFE_MS, fingerprint_hash: null, activated_at: null, rotated_at: null });
    // Nothing in the row, the table, or its index holds the token itself.
    for (const value of Object.values(row ?? {})) expect(String(value)).not.toContain(made.token);
    expect(fieldOf(row, 'key_hash')).not.toBe(made.token);
  });
});

const GOOD = { hostClass: 'cloud', launcher: 'orchestrated', label: 'my cloud env', allowRepos: ['acme/api', 'acme/web'] };

describe('POST /v1/machines/enroll', () => {
  it('enrolls a machine for the account and answers a one-time token that dies in 24 hours', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4302'));
    const before = Date.now();
    const answered = await pool.post('/v1/machines/enroll', GOOD, token);
    expect(answered).toMatchObject({ status: 201, json: { token: matching(/^[0-9a-f]{64}$/), machine: { id: anyText(), label: 'my cloud env', hostClass: 'cloud', launcher: 'orchestrated', allowRepos: ['acme/api', 'acme/web'], state: 'pending', expiresAt: anyNumber(), createdAt: anyNumber() } } });
    const machine = fieldOf(answered.json, 'machine');
    expect(Number(fieldOf(machine, 'expiresAt')) - before).toBeGreaterThanOrEqual(TOKEN_LIFE_MS);
    expect(Number(fieldOf(machine, 'expiresAt')) - before).toBeLessThan(TOKEN_LIFE_MS + 60_000);
    const row = await (await pool.db()).prepare('SELECT account, key_hash, state FROM machines WHERE id = ?').bind(textOf(machine, 'id')).first();
    expect(row).toMatchObject({ account, key_hash: sha256(textOf(answered.json, 'token')), state: 'pending' });
  });

  it('takes no allow list as an empty one and keeps each repository once', async () => {
    const { token } = await pool.signIn('github', stubUser('4303'));
    const bare = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box' }, token);
    expect(fieldOf(fieldOf(bare.json, 'machine'), 'allowRepos')).toEqual([]);
    const twice = await pool.post('/v1/machines/enroll', { ...GOOD, allowRepos: ['acme/api', 'acme/api', 'acme/.github'] }, token);
    expect(fieldOf(fieldOf(twice.json, 'machine'), 'allowRepos')).toEqual(['acme/api', 'acme/.github']);
  });

  it('refuses each value off its list or shape, naming the field, and writes nothing', async () => {
    const { token, account } = await pool.signIn('github', stubUser('4304'));
    const refused: Array<[object, number, string, string]> = [
      [{ ...GOOD, hostClass: undefined }, 400, 'missing_field', 'hostClass'],
      [{ ...GOOD, hostClass: 'local' }, 422, 'closed_vocabulary', 'hostClass'],
      [{ ...GOOD, hostClass: 'hosted' }, 422, 'closed_vocabulary', 'hostClass'],
      [{ ...GOOD, hostClass: 'mainframe' }, 422, 'closed_vocabulary', 'hostClass'],
      [{ ...GOOD, launcher: undefined }, 400, 'missing_field', 'launcher'],
      [{ ...GOOD, launcher: 'cron' }, 422, 'closed_vocabulary', 'launcher'],
      [{ ...GOOD, label: undefined }, 400, 'missing_field', 'label'],
      [{ ...GOOD, label: ' leading space' }, 422, 'invalid_field', 'label'],
      [{ ...GOOD, label: 'a'.repeat(65) }, 422, 'invalid_field', 'label'],
      [{ ...GOOD, label: 'drop;table' }, 422, 'invalid_field', 'label'],
      [{ ...GOOD, allowRepos: 'acme/api' }, 422, 'invalid_field', 'allowRepos'],
      [{ ...GOOD, allowRepos: ['acme'] }, 422, 'invalid_field', 'allowRepos'],
      [{ ...GOOD, allowRepos: ['acme/..'] }, 422, 'invalid_field', 'allowRepos'],
      [{ ...GOOD, allowRepos: [7] }, 422, 'invalid_field', 'allowRepos'],
      [{ ...GOOD, allowRepos: Array.from({ length: 101 }, (_, at) => `acme/r${String(at)}`) }, 422, 'invalid_field', 'allowRepos'],
    ];
    for (const [body, status, error, field] of refused) expect(await pool.post('/v1/machines/enroll', body, token)).toMatchObject({ status, json: { error, field } });
    expect(await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM machines WHERE account = ?').bind(account).first('count')).toBe(0);
  });

  it('wants the account credential: no credential and an unknown one are 401', async () => {
    expect(await pool.post('/v1/machines/enroll', GOOD)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
    expect(await pool.post('/v1/machines/enroll', GOOD, 'not-a-credential')).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
  });

  it('refuses a machine key with 403 deposit_only, so a machine cannot enroll another', async () => {
    const { token } = await pool.signIn('github', stubUser('4305'));
    const machineKey = textOf(await pool.post('/v1/machines/enroll', GOOD, token).then((answered) => answered.json), 'token');
    const before = await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM machines').first('count');
    expect(await pool.post('/v1/machines/enroll', GOOD, machineKey)).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    expect(await (await pool.db()).prepare('SELECT COUNT(*) AS count FROM machines').first('count')).toBe(before);
  });
});
