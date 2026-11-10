// The operator's withdrawal of raw consent (`erase withdraw`): the row the route leaves, the staged parts dropped, and the nightly sweep that erases the held objects.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/http.js';
import { sweepWithdrawnRaw } from '../src/raw.js';
import { acceptanceOf, fieldOf, startPool, stubUser, type TestPool } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import { storeOf } from './erase-test-store.js';
import { rawConsentOf, withdrawRaw } from './withdraw-account.js';

let pool: TestPool;
let next = 9800;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-1', 'oars-raw-consent': 'granted', 'oars-raw-consent-version': 'v1' };
const NOW = new Date('2026-11-10T12:00:00Z');
const store = async () => storeOf(await pool.db(), await pool.rawBucket(), await pool.bucket());
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** An account with a raw yes, one stored object, and one part staged and never completed. */
const holder = async (): Promise<{ token: string; account: string; held: string; staged: string }> => {
  next += 1;
  const { token, account } = await pool.signIn('github', stubUser(String(next)));
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token)).status).toBe(200);
  const held = sha(`held ${String(next)}`);
  expect((await pool.send(`/v1/raw/${held}/parts/1`, { method: 'PUT', body: `held ${String(next)}` }, token, grant)).status).toBe(200);
  expect((await pool.send(`/v1/raw/${held}/complete`, { method: 'POST', body: JSON.stringify({ parts: 1, bytes: `held ${String(next)}`.length }) }, token, grant)).status).toBe(201);
  const staged = sha(`staged ${String(next)}`);
  expect((await pool.send(`/v1/raw/${staged}/parts/1`, { method: 'PUT', body: 'half of a transcript' }, token, grant)).status).toBe(200);
  return { token, account, held, staged };
};

const rowOf = async (account: string): Promise<unknown> => (await (await pool.db()).prepare('SELECT raw_consent, raw_consent_version, raw_consent_withdrawn_version, raw_consent_withdrawn_at IS NOT NULL AS withdrawn FROM accounts WHERE id = ?').bind(account).first());
const stagedKeys = async (account: string): Promise<string[]> => (await (await pool.rawBucket()).list({ prefix: `staging/${account}/` })).objects.map((object) => object.key);

describe('erase withdraw', () => {
  it('leaves the row the route leaves on a twin, drops the staged parts, and lets the next sweep erase the held object with a tombstone', async () => {
    const routed = await holder();
    const scripted = await holder();
    expect((await pool.send('/v1/consent/raw', { method: 'DELETE' }, routed.token)).status).toBe(200);
    expect(await rawConsentOf(await store(), scripted.account)).toMatchObject({ standing: 'yes', withdrawnAt: null });
    expect(await stagedKeys(scripted.account)).toHaveLength(1);

    expect(await withdrawRaw(await store(), scripted.account, NOW)).toEqual({ withdrawn: true, stagedDropped: 1, stagedListed: true });
    expect(await rowOf(scripted.account)).toEqual(await rowOf(routed.account));
    expect(await stagedKeys(scripted.account)).toEqual([]);
    expect(await stagedKeys(routed.account)).toEqual([]);
    expect(await rawConsentOf(await store(), scripted.account)).toMatchObject({ standing: 'withdrawn' });

    const env = await pool.miniflare.getBindings<Env>();
    expect(await sweepWithdrawnRaw(env, NOW.getTime(), 40)).toBeGreaterThanOrEqual(2);
    const db = await pool.db();
    expect(fieldOf(await db.prepare('SELECT erased_on FROM raw_objects WHERE account = ? AND sha256 = ?').bind(scripted.account, scripted.held).first(), 'erased_on')).toBe('2026-11-10');
    expect((await (await pool.rawBucket()).get(`raw/${scripted.account}/${scripted.held}`))).toBeNull();
    expect(fieldOf(await db.prepare("SELECT COUNT(*) AS n FROM erasure_tombstones WHERE kind = 'raw-object' AND reason = 'consent-withdrawn'").first(), 'n')).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('changes nothing on a rerun, and drops only what was left staged for an account that already withdrew', async () => {
    const one = await holder();
    await withdrawRaw(await store(), one.account, NOW);
    const before = await rowOf(one.account);
    expect(await withdrawRaw(await store(), one.account, new Date('2026-11-11T00:00:00Z'))).toEqual({ withdrawn: false, stagedDropped: 0, stagedListed: true });
    expect(await rowOf(one.account)).toEqual(before);
    // A part that was staged between the two steps of an earlier run is dropped by the rerun, and the row stays.
    await (await pool.rawBucket()).put(`staging/${one.account}/${one.staged}/000001`, 'left');
    expect(await withdrawRaw(await store(), one.account, NOW)).toEqual({ withdrawn: false, stagedDropped: 1, stagedListed: true });
    expect(await stagedKeys(one.account)).toEqual([]);
  }, 60_000);

  it('touches nothing of an account that never said yes, refuses one the pool has never seen, and leaves another account\'s staged parts', async () => {
    const other = await holder();
    next += 1;
    const never = await pool.signIn('github', stubUser(String(next)));
    expect(await withdrawRaw(await store(), never.account, NOW)).toEqual({ withdrawn: false, stagedDropped: 0, stagedListed: true });
    expect(await rawConsentOf(await store(), never.account)).toMatchObject({ standing: 'never', withdrawnAt: null });
    await expect(withdrawRaw(await store(), 'acct_nobody', NOW)).rejects.toThrow(/No account acct_nobody in the pool/);
    expect(await stagedKeys(other.account)).toHaveLength(1);
  }, 60_000);

  it('records the withdrawal and says it listed nothing when the run cannot list the bucket, and deletes nothing on a listing that names a key outside the prefix', async () => {
    const one = await holder();
    const full = await store();
    const unlisted: EraseStore = { rows: full.rows, run: full.run, deleteObject: full.deleteObject, readObject: full.readObject, telemetry: full.telemetry };
    expect(await withdrawRaw(unlisted, one.account, NOW)).toEqual({ withdrawn: true, stagedDropped: 0, stagedListed: false });
    expect(await stagedKeys(one.account)).toHaveLength(1);
    const wrong = { ...(await store()), listRaw: () => Promise.resolve([`staging/${one.account}/a`, 'raw/someone/else']) };
    await expect(withdrawRaw(wrong, one.account, NOW)).rejects.toThrow(/not a staged part/);
    expect(await stagedKeys(one.account)).toHaveLength(1);
  }, 60_000);
});
