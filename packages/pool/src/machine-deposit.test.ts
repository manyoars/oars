// A deposit made with a machine key: the ledger row is stamped from the key (account, machine, host class, launcher) and never from the body, a key that is not live is refused by name, and the machine records the day of its last deposit.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

/** A signed-in account that accepted the covenant in force. */
const accountOn = async (id: string, accepted = true): Promise<{ token: string; account: string }> => {
  const signedIn = await pool.signIn('github', stubUser(id));
  if (accepted) await pool.post('/v1/covenant/accept', acceptanceOf('v1'), signedIn.token);
  return signedIn;
};

interface Machine {
  key: string;
  id: string;
}

/** A machine of the account, enrolled and activated. Its key is the enrollment token until a rotation replaces it. */
const machineOf = async (accountToken: string, declared: { hostClass: string; launcher: string }, activate = true): Promise<Machine> => {
  const enrolled = await pool.post('/v1/machines/enroll', { ...declared, label: 'deposit probe', allowRepos: [] }, accountToken);
  const key = textOf(enrolled.json, 'token');
  if (activate) await pool.post('/v1/machines/activate', {}, key);
  return { key, id: textOf(fieldOf(enrolled.json, 'machine'), 'id') };
};

const ledgerOf = async (account: string, id: string): Promise<unknown> =>
  (await pool.db()).prepare('SELECT machine, host_class, launcher, claimed_host_class, claimed_launcher FROM deposits WHERE account = ? AND id = ?').bind(account, id).first();

const depositCount = async (account: string): Promise<unknown> => (await pool.db()).prepare('SELECT COUNT(*) AS held FROM deposits WHERE account = ?').bind(account).first('held');

const lastDayOf = async (machine: string): Promise<unknown> => (await pool.db()).prepare('SELECT last_deposit_day FROM machines WHERE id = ?').bind(machine).first('last_deposit_day');

const today = (): string => new Date().toISOString().slice(0, 10);

describe('POST /v1/deposits with a machine key', () => {
  it.each([
    ['vps', 'scheduled', '00000000000a0001'],
    ['cloud', 'orchestrated', '00000000000a0002'],
    ['ci', 'interactive', '00000000000a0003'],
  ])('stamps a %s machine (launcher %s) from its enrollment, whatever the body says', async (hostClass, launcher, session) => {
    const { token, account } = await accountOn(`46${session.slice(-2)}`);
    const machine = await machineOf(token, { hostClass, launcher });
    // The body names another machine, class, launcher, and account at its top level: none of it is read as a stamp.
    const lying = { ...sampleSkeleton(session), machine: 'another-machine', hostClass: hostClass === 'ci' ? 'cloud' : 'ci', launcher: launcher === 'interactive' ? 'scheduled' : 'interactive', account: 'another-account' };
    expect(await pool.post('/v1/deposits', lying, machine.key)).toMatchObject({ status: 201, json: { ok: true, id: session } });
    expect(await ledgerOf(account, session)).toEqual({ machine: machine.id, host_class: hostClass, launcher, claimed_host_class: null, claimed_launcher: null });
  });

  it('stamps an account credential deposit as a person at a local machine: no machine, class local, launcher unknown', async () => {
    const { token, account } = await accountOn('4610');
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0010'), token)).toMatchObject({ status: 201 });
    expect(await ledgerOf(account, '00000000000a0010')).toEqual({ machine: null, host_class: 'local', launcher: 'unknown', claimed_host_class: null, claimed_launcher: null });
  });

  it('refuses an expired key 401 machine_expired and a revoked key 401 machine_revoked, and writes nothing', async () => {
    const { token, account } = await accountOn('4611');
    const lapsed = await machineOf(token, { hostClass: 'vps', launcher: 'scheduled' });
    await (await pool.db()).prepare('UPDATE machines SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, lapsed.id).run();
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0011'), lapsed.key)).toMatchObject({ status: 401, json: { error: 'machine_expired' } });
    const revoked = await machineOf(token, { hostClass: 'cloud', launcher: 'orchestrated' });
    expect((await pool.send(`/v1/machines/${revoked.id}`, { method: 'DELETE' }, token)).status).toBe(204);
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0012'), revoked.key)).toMatchObject({ status: 401, json: { error: 'machine_revoked' } });
    expect(await depositCount(account)).toBe(0);
  });

  it('refuses a token that has not been activated 409 not_activated, and one unused past its life 401 token_expired', async () => {
    const { token, account } = await accountOn('4612');
    const waiting = await machineOf(token, { hostClass: 'cloud', launcher: 'orchestrated' }, false);
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0013'), waiting.key)).toMatchObject({ status: 409, json: { error: 'not_activated' } });
    await (await pool.db()).prepare('UPDATE machines SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, waiting.id).run();
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0013'), waiting.key)).toMatchObject({ status: 401, json: { error: 'token_expired' } });
    expect(await depositCount(account)).toBe(0);
  });

  it('takes a rotated key and refuses the spent token by name', async () => {
    const { token, account } = await accountOn('4613');
    const machine = await machineOf(token, { hostClass: 'vps', launcher: 'scheduled' });
    const rotated = textOf(await pool.post('/v1/machines/rotate', {}, machine.key).then((answered) => answered.json), 'key');
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0014'), machine.key)).toMatchObject({ status: 401, json: { error: 'token_retired' } });
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0014'), rotated)).toMatchObject({ status: 201 });
    expect(await ledgerOf(account, '00000000000a0014')).toMatchObject({ machine: machine.id, host_class: 'vps', launcher: 'scheduled' });
  });

  it("wants the covenant its account accepted: a machine of an account that has not accepted is 403 covenant_not_accepted", async () => {
    const { token, account } = await accountOn('4614', false);
    const machine = await machineOf(token, { hostClass: 'ci', launcher: 'scheduled' });
    expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0015'), machine.key)).toMatchObject({ status: 403, json: { error: 'covenant_not_accepted' } });
    expect(await depositCount(account)).toBe(0);
  });

  it('answers a bearer that is no credential at all as before: 401 unauthorized, sign in first', async () => {
    for (const bearer of [undefined, 'not-a-credential', sha256('looks like a key')]) {
      expect(await pool.post('/v1/deposits', sampleSkeleton('00000000000a0016'), bearer)).toMatchObject({ status: 401, json: { error: 'unauthorized', message: 'Sign in with oars pool login first.' } });
    }
  });

  it('stamps a session sent again with the credential of the write that last set the row', async () => {
    const { token, account } = await accountOn('4615');
    const machine = await machineOf(token, { hostClass: 'cloud', launcher: 'orchestrated' });
    const session = '00000000000a0017';
    expect((await pool.post('/v1/deposits', sampleSkeleton(session), token)).status).toBe(201);
    expect(await ledgerOf(account, session)).toMatchObject({ machine: null, host_class: 'local' });
    expect((await pool.post('/v1/deposits', sampleSkeleton(session), machine.key)).status).toBe(201);
    expect(await ledgerOf(account, session)).toMatchObject({ machine: machine.id, host_class: 'cloud', launcher: 'orchestrated' });
    expect((await pool.post('/v1/deposits', sampleSkeleton(session), token)).status).toBe(201);
    expect(await ledgerOf(account, session)).toMatchObject({ machine: null, host_class: 'local', launcher: 'unknown' });
  });

  it("stamps a batch sent in parts from the key of the request that completes it", async () => {
    const { token, account } = await accountOn('4616');
    const machine = await machineOf(token, { hostClass: 'ci', launcher: 'scheduled' });
    const whole = JSON.stringify(sampleSkeleton('00000000000a0018'));
    const middle = Math.floor(whole.length / 2);
    const headers = (part: number): { [name: string]: string } => ({ 'oars-batch': sha256(whole), 'oars-part': `${String(part)}/2` });
    expect(await pool.post('/v1/deposits', whole.slice(0, middle), machine.key, headers(1))).toMatchObject({ status: 202 });
    expect(await pool.post('/v1/deposits', whole.slice(middle), machine.key, headers(2))).toMatchObject({ status: 201, json: { ok: true, id: '00000000000a0018' } });
    expect(await ledgerOf(account, '00000000000a0018')).toMatchObject({ machine: machine.id, host_class: 'ci', launcher: 'scheduled' });
  });
});

describe("a machine's last deposit day", () => {
  it('is empty until the machine deposits, then the UTC day of its last stored deposit; an account credential deposit moves no machine', async () => {
    const { token } = await accountOn('4620');
    const machine = await machineOf(token, { hostClass: 'vps', launcher: 'scheduled' });
    const other = await machineOf(token, { hostClass: 'vps', launcher: 'scheduled' });
    expect(await lastDayOf(machine.id)).toBeNull();
    const before = today();
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a0020'), machine.key)).status).toBe(201);
    expect([before, today()]).toContain(await lastDayOf(machine.id));
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a0021'), token)).status).toBe(201);
    expect(await lastDayOf(other.id)).toBeNull();
  });

  it('lists the day of the last deposit, null before a first one', async () => {
    const { token } = await accountOn('4625');
    const machine = await machineOf(token, { hostClass: 'vps', launcher: 'scheduled' });
    const listed = async (): Promise<unknown> => fieldOf((await pool.get('/v1/machines', token)).json, 'machines');
    expect(await listed()).toMatchObject([{ id: machine.id, lastDepositDay: null }]);
    const before = today();
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a0030'), machine.key)).status).toBe(201);
    const [row] = (await listed()) as { lastDepositDay: string }[];
    expect([before, today()]).toContain(row?.lastDepositDay);
  });

  it('does not move for a deposit the operator brake refuses', async () => {
    const braked = await startPool({ MAX_DEPOSITS_PER_ACCOUNT: '1' });
    try {
      const { token } = await braked.signIn('github', stubUser('4621'));
      await braked.post('/v1/covenant/accept', acceptanceOf('v1'), token);
      const enrolled = await braked.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'braked' }, token);
      const key = textOf(enrolled.json, 'token');
      const id = textOf(fieldOf(enrolled.json, 'machine'), 'id');
      await braked.post('/v1/machines/activate', {}, key);
      expect((await braked.post('/v1/deposits', sampleSkeleton('00000000000a0022'), key)).status).toBe(201);
      await (await braked.db()).prepare('UPDATE machines SET last_deposit_day = ? WHERE id = ?').bind('2000-01-01', id).run();
      expect(await braked.post('/v1/deposits', sampleSkeleton('00000000000a0023'), key)).toMatchObject({ status: 403, json: { error: 'deposit_limit' } });
      expect(await (await braked.db()).prepare('SELECT last_deposit_day FROM machines WHERE id = ?').bind(id).first('last_deposit_day')).toBe('2000-01-01');
      expect(fieldOf((await braked.get('/v1/machines', token)).json, 'machines')).toMatchObject([{ id, lastDepositDay: '2000-01-01' }]);
      // A session already held is replaced, not added, so the brake lets it through and the day moves.
      const before = today();
      expect((await braked.post('/v1/deposits', sampleSkeleton('00000000000a0022'), key)).status).toBe(201);
      expect([before, today()]).toContain(await (await braked.db()).prepare('SELECT last_deposit_day FROM machines WHERE id = ?').bind(id).first('last_deposit_day'));
    } finally {
      await braked.dispose();
    }
  });
});
