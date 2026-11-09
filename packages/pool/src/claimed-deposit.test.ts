// `claimed`: the one field of a batch the pool believes about the batch itself. A batch held on a branch or pulled from a cloud session is sent later under the account credential, and its sender states the class and launcher it ran under. The pool keeps that beside its own stamp and never in place of it; a machine's key claims nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_CLASSES } from '../../cli/src/sessions/machine.js';
import { LEDGER_HOST_CLASSES, LEDGER_LAUNCHERS } from './provenance.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const accountOn = async (id: string): Promise<{ token: string; account: string }> => {
  const signedIn = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', acceptanceOf('v1'), signedIn.token);
  return signedIn;
};

const ledgerOf = async (account: string, id: string): Promise<unknown> =>
  (await pool.db()).prepare('SELECT machine, host_class, launcher, claimed_host_class, claimed_launcher, skeleton, extensions FROM deposits WHERE account = ? AND id = ?').bind(account, id).first();

const depositCount = async (account: string): Promise<unknown> => (await pool.db()).prepare('SELECT COUNT(*) AS held FROM deposits WHERE account = ?').bind(account).first('held');

describe('the lists a claim is checked against', () => {
  it('are the host classes the client names and the launchers the ledger holds', () => {
    expect([...LEDGER_HOST_CLASSES].sort()).toEqual([...HOST_CLASSES].sort());
    expect([...LEDGER_LAUNCHERS].sort()).toEqual(['ci', 'hosted-run', 'interactive', 'orchestrated', 'scheduled', 'unknown']);
  });
});

describe('claimed on a batch sent under the account credential', () => {
  it('is kept beside the stamp, which stays the account credential\'s, and is no part of the stored skeleton or its bag', async () => {
    const { token, account } = await accountOn('4701');
    const session = '00000000000b0001';
    const sent = { ...sampleSkeleton(session), claimed: { hostClass: 'cloud', launcher: 'orchestrated' } };
    expect(await pool.post('/v1/deposits', sent, token)).toMatchObject({ status: 201, json: { ok: true, id: session } });
    const row = await ledgerOf(account, session);
    expect(row).toMatchObject({ machine: null, host_class: 'local', launcher: 'unknown', claimed_host_class: 'cloud', claimed_launcher: 'orchestrated', extensions: '[]' });
    expect(textOf(row, 'skeleton')).not.toContain('claimed');
  });

  it('takes every class and every launcher on its lists', async () => {
    const { token, account } = await accountOn('4702');
    for (const [at, hostClass] of LEDGER_HOST_CLASSES.entries()) {
      const launcher = LEDGER_LAUNCHERS[at % LEDGER_LAUNCHERS.length] ?? 'unknown';
      const session = `00000000000b01${String(at).padStart(2, '0')}`;
      expect((await pool.post('/v1/deposits', { ...sampleSkeleton(session), claimed: { hostClass, launcher } }, token)).status).toBe(201);
      expect(await ledgerOf(account, session)).toMatchObject({ claimed_host_class: hostClass, claimed_launcher: launcher });
    }
    for (const [at, launcher] of LEDGER_LAUNCHERS.entries()) {
      const session = `00000000000b02${String(at).padStart(2, '0')}`;
      expect((await pool.post('/v1/deposits', { ...sampleSkeleton(session), claimed: { hostClass: 'vps', launcher } }, token)).status).toBe(201);
      expect(await ledgerOf(account, session)).toMatchObject({ claimed_launcher: launcher });
    }
  });

  it('is left null when the batch carries none, or carries null, and a resend without it clears an earlier claim', async () => {
    const { token, account } = await accountOn('4703');
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000b0301'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', { ...sampleSkeleton('00000000000b0302'), claimed: null }, token)).status).toBe(201);
    for (const session of ['00000000000b0301', '00000000000b0302']) expect(await ledgerOf(account, session)).toMatchObject({ claimed_host_class: null, claimed_launcher: null });
    const held = '00000000000b0303';
    expect((await pool.post('/v1/deposits', { ...sampleSkeleton(held), claimed: { hostClass: 'ci', launcher: 'scheduled' } }, token)).status).toBe(201);
    expect(await ledgerOf(account, held)).toMatchObject({ claimed_host_class: 'ci', claimed_launcher: 'scheduled' });
    expect((await pool.post('/v1/deposits', sampleSkeleton(held), token)).status).toBe(201);
    expect(await ledgerOf(account, held)).toMatchObject({ claimed_host_class: null, claimed_launcher: null });
  });

  it('refuses each value off its list or shape, naming its field, and writes nothing', async () => {
    const { token, account } = await accountOn('4704');
    const good = { hostClass: 'cloud', launcher: 'scheduled' };
    const refused: Array<[unknown, string]> = [
      [{ ...good, hostClass: 'mainframe' }, 'claimed.hostClass'],
      [{ ...good, hostClass: 7 }, 'claimed.hostClass'],
      [{ ...good, hostClass: null }, 'claimed.hostClass'],
      [{ launcher: 'scheduled' }, 'claimed.hostClass'],
      [{}, 'claimed.hostClass'],
      [{ ...good, launcher: 'cron' }, 'claimed.launcher'],
      [{ ...good, launcher: ['scheduled'] }, 'claimed.launcher'],
      [{ hostClass: 'cloud' }, 'claimed.launcher'],
      [{ ...good, extra: 'x' }, 'claimed.extra'],
      [{ ...good, 'not a field name': 'x' }, 'claimed'],
      ['cloud', 'claimed'],
      [['cloud', 'scheduled'], 'claimed'],
      [7, 'claimed'],
    ];
    for (const [claimed, field] of refused) {
      const answered = await pool.post('/v1/deposits', { ...sampleSkeleton('00000000000b0401'), claimed }, token);
      expect({ claimed, status: answered.status, error: fieldOf(answered.json, 'error'), field: fieldOf(answered.json, 'field') }).toEqual({ claimed, status: 422, error: 'closed_vocabulary', field });
    }
    expect(await depositCount(account)).toBe(0);
  });
});

describe('claimed on a batch sent with a machine key', () => {
  it('is refused whatever it says, because the stamp comes from the key and only a held or pulled batch claims', async () => {
    const { token, account } = await accountOn('4710');
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'claimant' }, token);
    const key = textOf(enrolled.json, 'token');
    await pool.post('/v1/machines/activate', {}, key);
    const claims: unknown[] = [
      { hostClass: 'vps', launcher: 'scheduled' },
      { hostClass: 'cloud', launcher: 'scheduled' },
      { hostClass: 'vps', launcher: 'orchestrated' },
      { hostClass: 'mainframe', launcher: 'cron' },
      'vps',
    ];
    for (const claimed of claims) {
      const answered = await pool.post('/v1/deposits', { ...sampleSkeleton('00000000000b0501'), claimed }, key);
      expect({ claimed, status: answered.status, error: fieldOf(answered.json, 'error'), field: fieldOf(answered.json, 'field') }).toEqual({ claimed, status: 422, error: 'closed_vocabulary', field: 'claimed' });
    }
    expect(await depositCount(account)).toBe(0);
    // No claim is no claim: a null one is not refused, and the row is stamped from the key alone.
    expect((await pool.post('/v1/deposits', { ...sampleSkeleton('00000000000b0502'), claimed: null }, key)).status).toBe(201);
    expect(await ledgerOf(account, '00000000000b0502')).toMatchObject({ host_class: 'vps', launcher: 'scheduled', claimed_host_class: null, claimed_launcher: null });
  });
});
