// Machine keys: the table a machine's key is kept in, and the routes that enroll, activate, rotate, list, and revoke one.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { createMachine, KEY_LIFE_MS, TOKEN_LIFE_MS } from './machines.js';
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
    // Nothing in the row holds the token itself.
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
      [{ ...GOOD, label: ' padded with a space' }, 422, 'invalid_field', 'label'],
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

/** Enrolls a machine as the signed-in account and returns its token and id. */
const enrolled = async (accountToken: string, declared: object = {}): Promise<{ key: string; id: string }> => {
  const answered = await pool.post('/v1/machines/enroll', { ...GOOD, ...declared }, accountToken);
  return { key: textOf(answered.json, 'token'), id: textOf(fieldOf(answered.json, 'machine'), 'id') };
};
const activate = (key?: string): ReturnType<TestPool['post']> => pool.post('/v1/machines/activate', {}, key);
const rotate = (key?: string): ReturnType<TestPool['post']> => pool.post('/v1/machines/rotate', {}, key);
const rowOf = async (id: string): Promise<unknown> => (await pool.db()).prepare('SELECT * FROM machines WHERE id = ?').bind(id).first();
const setRow = async (id: string, column: 'expires_at' | 'state' | 'created_at', value: string | number): Promise<void> => {
  await (await pool.db()).prepare(`UPDATE machines SET ${column} = ? WHERE id = ?`).bind(value, id).run();
};

describe('POST /v1/machines/activate', () => {
  it('binds a pending token as the machine key: active, 90 days out, and a cloud runtime is told it need not rotate', async () => {
    const { token } = await pool.signIn('github', stubUser('4310'));
    const { key, id } = await enrolled(token);
    const before = Date.now();
    const answered = await activate(key);
    expect(answered).toMatchObject({ status: 200, json: { rotate: false, machine: { id, hostClass: 'cloud', label: 'my cloud env', state: 'active' } } });
    const expiresAt = Number(fieldOf(fieldOf(answered.json, 'machine'), 'expiresAt'));
    expect(expiresAt - before).toBeGreaterThanOrEqual(KEY_LIFE_MS);
    expect(expiresAt - before).toBeLessThan(KEY_LIFE_MS + 60_000);
    expect(await rowOf(id)).toMatchObject({ state: 'active', key_hash: sha256(key), expires_at: expiresAt, activated_at: anyNumber(), retired_hash: null });
  });

  it('answers {machine, rotate: false} again on an already active cloud key, and moves nothing', async () => {
    const { token } = await pool.signIn('github', stubUser('4311'));
    const { key, id } = await enrolled(token);
    const first = await activate(key);
    expect(first).toMatchObject({ status: 200, json: { rotate: false, machine: { id, state: 'active' } } });
    const rowAfterFirst = await rowOf(id);
    // Every fresh VM of a proxy-held runtime presents the same active key as a first use.
    for (let session = 0; session < 3; session += 1) expect(await activate(key)).toEqual(first);
    expect(await rowOf(id)).toEqual(rowAfterFirst);
  });

  it('answers {machine, rotate: true} again on an active, unrotated key of a durable class, so a machine that died before rotating is not bricked', async () => {
    const { token } = await pool.signIn('github', stubUser('4312'));
    for (const hostClass of ['vps', 'ci']) {
      const { key, id } = await enrolled(token, { hostClass });
      expect(await activate(key)).toMatchObject({ status: 200, json: { rotate: true, machine: { id, state: 'active' } } });
      const rowAfterFirst = await rowOf(id);
      expect(await activate(key)).toMatchObject({ status: 200, json: { rotate: true, machine: { id, state: 'active' } } });
      expect(await rowOf(id)).toEqual(rowAfterFirst);
    }
  });

  it('refuses a token that rotation retired on any class but cloud, and the key that replaced it is active and not rotated again', async () => {
    const { token } = await pool.signIn('github', stubUser('4313'));
    for (const hostClass of ['vps', 'ci']) {
      const { key: spent } = await enrolled(token, { hostClass });
      await activate(spent);
      const fresh = textOf((await rotate(spent)).json, 'key');
      expect(await activate(spent)).toMatchObject({ status: 401, json: { error: 'token_retired' } });
      expect(await activate(fresh)).toMatchObject({ status: 200, json: { rotate: false, machine: { state: 'active' } } });
    }
  });

  it('refuses a token unused for 24 hours, a key past its 90 days, a revoked machine, and a bearer that is no machine key', async () => {
    const { token } = await pool.signIn('github', stubUser('4314'));
    const stale = await enrolled(token);
    await setRow(stale.id, 'expires_at', Date.now() - 1);
    expect(await activate(stale.key)).toMatchObject({ status: 401, json: { error: 'token_expired' } });
    expect(await rowOf(stale.id)).toMatchObject({ state: 'pending' });
    const lapsed = await enrolled(token);
    await activate(lapsed.key);
    await setRow(lapsed.id, 'expires_at', Date.now() - 1);
    expect(await activate(lapsed.key)).toMatchObject({ status: 401, json: { error: 'machine_expired' } });
    const revoked = await enrolled(token);
    await activate(revoked.key);
    await setRow(revoked.id, 'state', 'revoked');
    expect(await activate(revoked.key)).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    for (const bearer of [undefined, 'not-a-key', token]) expect(await activate(bearer)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
  });
});

describe('POST /v1/machines/rotate', () => {
  it('answers a fresh key for an active durable machine, retires the token hash, and keeps the expiry', async () => {
    const { token } = await pool.signIn('github', stubUser('4320'));
    const { key, id } = await enrolled(token, { hostClass: 'vps' });
    await activate(key);
    const before = await rowOf(id);
    const answered = await rotate(key);
    expect(answered).toMatchObject({ status: 200, json: { key: matching(/^[0-9a-f]{64}$/), machine: { id, state: 'active', expiresAt: fieldOf(before, 'expires_at') } } });
    const fresh = textOf(answered.json, 'key');
    expect(fresh).not.toBe(key);
    const after = await rowOf(id);
    expect(after).toMatchObject({ key_hash: sha256(fresh), retired_hash: sha256(key), rotated_at: anyNumber(), expires_at: fieldOf(before, 'expires_at') });
    // Neither key is in the row in the clear.
    for (const value of Object.values(after ?? {})) expect([key, fresh].some((secret) => String(value).includes(secret))).toBe(false);
  });

  it('refuses a token that rotation already spent, with the same refusal at rotate as at activate', async () => {
    const { token } = await pool.signIn('github', stubUser('4321'));
    const { key } = await enrolled(token, { hostClass: 'vps' });
    await activate(key);
    await rotate(key);
    expect(await rotate(key)).toMatchObject({ status: 401, json: { error: 'token_retired' } });
  });

  it('keeps only the latest replaced key: after two rotations the first token is unknown and the second is retired', async () => {
    const { token } = await pool.signIn('github', stubUser('4322'));
    const first = await enrolled(token, { hostClass: 'vps' });
    await activate(first.key);
    const second = textOf((await rotate(first.key)).json, 'key');
    const third = textOf((await rotate(second)).json, 'key');
    expect(await activate(first.key)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
    expect(await activate(second)).toMatchObject({ status: 401, json: { error: 'token_retired' } });
    expect(await activate(third)).toMatchObject({ status: 200, json: { rotate: false } });
  });

  it('refuses a token not yet activated, and a cloud key, which has nowhere to keep a rotated key', async () => {
    const { token } = await pool.signIn('github', stubUser('4322'));
    const pending = await enrolled(token, { hostClass: 'vps' });
    expect(await rotate(pending.key)).toMatchObject({ status: 409, json: { error: 'not_activated' } });
    const cloud = await enrolled(token);
    await activate(cloud.key);
    expect(await rotate(cloud.key)).toMatchObject({ status: 409, json: { error: 'not_rotatable' } });
    expect(await rowOf(cloud.id)).toMatchObject({ key_hash: sha256(cloud.key), retired_hash: null, rotated_at: null });
  });

  it('wants a machine key: no credential, an unknown one, and the account credential are 401', async () => {
    const { token } = await pool.signIn('github', stubUser('4323'));
    for (const bearer of [undefined, 'not-a-key', token]) expect(await rotate(bearer)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
  });
});

const revoke = (id: string, bearer?: string): ReturnType<TestPool['send']> => pool.send(`/v1/machines/${id}`, { method: 'DELETE' }, bearer);
const listed = async (bearer?: string): Promise<unknown[]> => {
  const machines = fieldOf((await pool.get('/v1/machines', bearer)).json, 'machines');
  return Array.isArray(machines) ? machines.map((machine: unknown) => machine) : [];
};

describe('GET /v1/machines', () => {
  it('lists the caller\'s machines as views with their state, never a hash or a key, and not another account\'s', async () => {
    const mine = await pool.signIn('github', stubUser('4330'));
    const theirs = await pool.signIn('github', stubUser('4331'));
    const waiting = await enrolled(mine.token, { label: 'waiting', hostClass: 'vps', allowRepos: [] });
    const live = await enrolled(mine.token, { label: 'live' });
    await activate(live.key);
    const lapsed = await enrolled(mine.token, { label: 'lapsed', hostClass: 'ci' });
    await activate(lapsed.key);
    await setRow(lapsed.id, 'expires_at', Date.now() - 1);
    await enrolled(theirs.token, { label: 'not mine' });
    const answered = await pool.get('/v1/machines', mine.token);
    expect(answered.status).toBe(200);
    const machines = (await listed(mine.token)).sort((left, right) => textOf(left, 'label').localeCompare(textOf(right, 'label')));
    expect(machines).toMatchObject([
      { id: lapsed.id, label: 'lapsed', hostClass: 'ci', launcher: 'orchestrated', state: 'expired', allowRepos: ['acme/api', 'acme/web'], expiresAt: anyNumber(), createdAt: anyNumber() },
      { id: live.id, label: 'live', hostClass: 'cloud', state: 'active' },
      { id: waiting.id, label: 'waiting', hostClass: 'vps', state: 'pending', allowRepos: [] },
    ]);
    const text = JSON.stringify(answered.json);
    for (const secret of [live.key, waiting.key, sha256(live.key), sha256(waiting.key), 'key_hash', 'retired_hash']) expect(text).not.toContain(secret);
  });

  it('lists newest first, by when each was enrolled', async () => {
    const { token } = await pool.signIn('github', stubUser('4333'));
    const [oldest, newest, middle] = [await enrolled(token), await enrolled(token), await enrolled(token)];
    await setRow(oldest.id, 'created_at', 1000);
    await setRow(newest.id, 'created_at', 3000);
    await setRow(middle.id, 'created_at', 2000);
    expect((await listed(token)).map((machine) => textOf(machine, 'id'))).toEqual([newest.id, middle.id, oldest.id]);
  });

  it('lists nothing for an account with no machines, and is the account credential\'s alone', async () => {
    const { token } = await pool.signIn('github', stubUser('4332'));
    expect(await pool.get('/v1/machines', token)).toMatchObject({ status: 200, json: { machines: [] } });
    for (const bearer of [undefined, 'not-a-credential']) expect(await pool.get('/v1/machines', bearer)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
    const { key } = await enrolled(token);
    expect(await pool.get('/v1/machines', key)).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    await activate(key);
    expect(await pool.get('/v1/machines', key)).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
  });
});

describe('DELETE /v1/machines/:id', () => {
  it('revokes the caller\'s machine: 204, gone from the list, and its key is refused at the next use', async () => {
    const { token } = await pool.signIn('github', stubUser('4340'));
    const live = await enrolled(token, { hostClass: 'vps' });
    await activate(live.key);
    const waiting = await enrolled(token);
    const kept = await enrolled(token);
    expect(await revoke(live.id, token)).toMatchObject({ status: 204, json: null });
    expect(await revoke(waiting.id, token)).toMatchObject({ status: 204, json: null });
    expect(await rowOf(live.id)).toMatchObject({ state: 'revoked' });
    expect((await listed(token)).map((machine) => textOf(machine, 'id'))).toEqual([kept.id]);
    expect(await activate(live.key)).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    expect(await rotate(live.key)).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    expect(await activate(waiting.key)).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    // A repeat finds nothing to revoke, and the machine left alone still works.
    expect(await revoke(live.id, token)).toMatchObject({ status: 404, json: { error: 'not_found' } });
    expect(await activate(kept.key)).toMatchObject({ status: 200 });
  });

  it('cannot reach another account\'s machine: it is not listed, and revoking it is 404 and changes nothing', async () => {
    const mine = await pool.signIn('github', stubUser('4341'));
    const theirs = await pool.signIn('github', stubUser('4342'));
    const stranger = await enrolled(theirs.token, { label: 'not mine' });
    await activate(stranger.key);
    expect(await listed(mine.token)).toEqual([]);
    expect(await revoke(stranger.id, mine.token)).toMatchObject({ status: 404, json: { error: 'not_found' } });
    expect(await revoke('no-such-machine', mine.token)).toMatchObject({ status: 404, json: { error: 'not_found' } });
    expect(await rowOf(stranger.id)).toMatchObject({ state: 'active' });
    expect(await activate(stranger.key)).toMatchObject({ status: 200, json: { machine: { id: stranger.id, state: 'active' } } });
    expect(await revoke(stranger.id, theirs.token)).toMatchObject({ status: 204 });
  });

  it('wants the account credential: no credential and an unknown one are 401, and a machine key is 403 deposit_only and revokes nothing', async () => {
    const { token } = await pool.signIn('github', stubUser('4343'));
    const first = await enrolled(token);
    const second = await enrolled(token);
    await activate(first.key);
    for (const bearer of [undefined, 'not-a-credential']) expect(await revoke(first.id, bearer)).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
    // Its own key, another machine's key, and a token not yet activated.
    const attempts: Array<[string, string]> = [[first.id, first.key], [second.id, first.key], [first.id, second.key]];
    for (const [id, bearer] of attempts) expect(await revoke(id, bearer)).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    expect(await rowOf(first.id)).toMatchObject({ state: 'active' });
    expect(await rowOf(second.id)).toMatchObject({ state: 'pending' });
  });
});
