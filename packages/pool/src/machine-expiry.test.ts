// How long a machine key lives and how the machine learns it: enrollment's `days` sets the life from activation, and the deposit and covenant answers carry `machineExpiresAt` for a machine key so the machine can warn before the key ends.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_LIFE_MS, MAX_KEY_DAYS, TOKEN_LIFE_MS } from './machines.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, anyNumber, fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const accountOn = async (id: string, accepted = true): Promise<{ token: string; account: string }> => {
  const signedIn = await pool.signIn('github', stubUser(id));
  if (accepted) await pool.post('/v1/covenant/accept', acceptanceOf('v1'), signedIn.token);
  return signedIn;
};

const DECLARED = { hostClass: 'cloud', launcher: 'orchestrated', label: 'expiry probe' };

/** Enrolls a machine, asking for `days` when given, and returns the token and id. */
const enrolled = async (accountToken: string, days?: unknown): Promise<{ key: string; id: string; answered: Awaited<ReturnType<TestPool['post']>> }> => {
  const answered = await pool.post('/v1/machines/enroll', days === undefined ? DECLARED : { ...DECLARED, days }, accountToken);
  return { key: textOf(answered.json, 'token'), id: textOf(fieldOf(answered.json, 'machine'), 'id'), answered };
};

const rowOf = async (id: string): Promise<{ activated_at: number; expires_at: number }> => {
  const row = await (await pool.db()).prepare('SELECT activated_at, expires_at FROM machines WHERE id = ?').bind(id).first();
  return { activated_at: Number(fieldOf(row, 'activated_at')), expires_at: Number(fieldOf(row, 'expires_at')) };
};

describe('POST /v1/machines/enroll days', () => {
  it('is the life of the key from its activation: 90 days when left out, and the days asked for otherwise', async () => {
    const { token } = await accountOn('4801');
    for (const [days, life] of [[undefined, KEY_LIFE_MS], [90, 90 * DAY_MS], [1, DAY_MS], [30, 30 * DAY_MS], [MAX_KEY_DAYS, 365 * DAY_MS]] as const) {
      const { key, id } = await enrolled(token, days);
      await pool.post('/v1/machines/activate', {}, key);
      const held = await rowOf(id);
      expect({ days, life: held.expires_at - held.activated_at }).toEqual({ days, life });
    }
  });

  it('leaves the token its 24 hours, whatever the key will live', async () => {
    const { token } = await accountOn('4802');
    const before = Date.now();
    const { answered } = await enrolled(token, 365);
    const expiresAt = Number(fieldOf(fieldOf(answered.json, 'machine'), 'expiresAt'));
    expect(expiresAt - before).toBeGreaterThanOrEqual(TOKEN_LIFE_MS);
    expect(expiresAt - before).toBeLessThan(TOKEN_LIFE_MS + 60_000);
  });

  it('does not move when a key already active is activated again or rotated', async () => {
    const { token } = await accountOn('4803');
    const vps = await pool.post('/v1/machines/enroll', { ...DECLARED, hostClass: 'vps', days: 7 }, token);
    const key = textOf(vps.json, 'token');
    const id = textOf(fieldOf(vps.json, 'machine'), 'id');
    await pool.post('/v1/machines/activate', {}, key);
    const before = await rowOf(id);
    expect(before.expires_at - before.activated_at).toBe(7 * DAY_MS);
    await pool.post('/v1/machines/activate', {}, key);
    expect(await pool.post('/v1/machines/rotate', {}, key)).toMatchObject({ status: 200 });
    expect(await rowOf(id)).toEqual(before);
  });

  it('refuses a value that is not a whole number of days from 1 to 365, naming the field, and writes nothing', async () => {
    const { token, account } = await accountOn('4804');
    const refused: unknown[] = [366, 1000, 0, -1, -90, 1.5, 0.5, '30', null, true, [30], { days: 30 }, Number.MAX_SAFE_INTEGER, 1e21];
    for (const days of refused) {
      const answered = await pool.post('/v1/machines/enroll', { ...DECLARED, days }, token);
      expect({ days, status: answered.status, error: fieldOf(answered.json, 'error'), field: fieldOf(answered.json, 'field') }).toEqual({ days, status: 422, error: 'invalid_field', field: 'days' });
    }
    expect(await (await pool.db()).prepare('SELECT COUNT(*) AS held FROM machines WHERE account = ?').bind(account).first('held')).toBe(0);
  });
});

describe('machineExpiresAt', () => {
  it('rides the deposit answer for a machine key, as the key\'s expiry, and is absent for an account credential', async () => {
    const { token } = await accountOn('4810');
    const { key, id } = await enrolled(token, 45);
    await pool.post('/v1/machines/activate', {}, key);
    const { expires_at: expiresAt } = await rowOf(id);
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000c0001'), key)).toMatchObject({ status: 201, json: { ok: true, id: '00000000000c0001', machineExpiresAt: expiresAt } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000c0002'), token)).toEqual({ status: 201, json: { ok: true, id: '00000000000c0002' } });
  });

  it('rides the last answer of a batch sent in parts', async () => {
    const { token } = await accountOn('4811');
    const { key, id } = await enrolled(token);
    await pool.post('/v1/machines/activate', {}, key);
    const whole = JSON.stringify(sampleSkeleton('00000000000c0003'));
    const middle = Math.floor(whole.length / 2);
    const headers = (part: number): { [name: string]: string } => ({ 'oars-batch': sha256(whole), 'oars-part': `${String(part)}/2` });
    expect(await pool.post('/v1/deposits', whole.slice(0, middle), key, headers(1))).toMatchObject({ status: 202 });
    expect(await pool.post('/v1/deposits', whole.slice(middle), key, headers(2))).toMatchObject({ status: 201, json: { machineExpiresAt: (await rowOf(id)).expires_at } });
  });

  it('rides the covenant answer for a machine key, which reads its account\'s acceptance, and is absent for the account credential and for no credential', async () => {
    const accepted = await accountOn('4812');
    const waiting = await accountOn('4813', false);
    const live = await enrolled(accepted.token, 60);
    const idle = await enrolled(waiting.token);
    for (const machine of [live, idle]) await pool.post('/v1/machines/activate', {}, machine.key);
    expect(await pool.get('/v1/covenant', live.key)).toMatchObject({ status: 200, json: { version: 'v1', accepted: true, machineExpiresAt: (await rowOf(live.id)).expires_at } });
    expect(await pool.get('/v1/covenant', idle.key)).toMatchObject({ status: 200, json: { version: 'v1', accepted: false, machineExpiresAt: anyNumber() } });
    for (const bearer of [accepted.token, undefined, 'not-a-credential']) {
      const answered = await pool.get('/v1/covenant', bearer);
      expect(answered).toMatchObject({ status: 200, json: { version: 'v1', accepted: bearer === accepted.token } });
      expect(fieldOf(answered.json, 'machineExpiresAt')).toBeUndefined();
    }
  });

  it('is refused by name at the covenant route for a key that is not live: expired, revoked, retired, or not yet activated', async () => {
    const { token } = await accountOn('4814');
    const lapsed = await enrolled(token);
    await pool.post('/v1/machines/activate', {}, lapsed.key);
    await (await pool.db()).prepare('UPDATE machines SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, lapsed.id).run();
    expect(await pool.get('/v1/covenant', lapsed.key)).toMatchObject({ status: 401, json: { error: 'machine_expired' } });
    const revoked = await enrolled(token);
    await pool.post('/v1/machines/activate', {}, revoked.key);
    await pool.send(`/v1/machines/${revoked.id}`, { method: 'DELETE' }, token);
    expect(await pool.get('/v1/covenant', revoked.key)).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    const waiting = await enrolled(token);
    expect(await pool.get('/v1/covenant', waiting.key)).toMatchObject({ status: 409, json: { error: 'not_activated' } });
    const vps = await pool.post('/v1/machines/enroll', { ...DECLARED, hostClass: 'vps' }, token);
    const spent = textOf(vps.json, 'token');
    await pool.post('/v1/machines/activate', {}, spent);
    await pool.post('/v1/machines/rotate', {}, spent);
    expect(await pool.get('/v1/covenant', spent)).toMatchObject({ status: 401, json: { error: 'token_retired' } });
  });
});
