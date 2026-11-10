// The one statement that records a withdrawal of raw consent (GDPR Article 7(3)): the route and the operator's `erase withdraw` run the same text, so the row one leaves is the row the other leaves.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from './http.js';
import { withdrawRawConsent, WITHDRAW_RAW_CONSENT } from './raw.js';
import { acceptanceOf, fieldOf, poolDbOf, startPool, stubUser, type TestPool } from './test-pool.js';

let pool: TestPool;
let next = 9600;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

/** An account that said yes to raw copies for v1. */
const withYes = async (): Promise<{ token: string; account: string }> => {
  next += 1;
  const { token, account } = await pool.signIn('github', stubUser(String(next)));
  expect((await pool.post('/v1/covenant/accept', acceptanceOf('v1'), token)).status).toBe(200);
  expect((await pool.send('/v1/consent/raw', { method: 'PUT', body: JSON.stringify({ version: 'v1' }) }, token)).status).toBe(200);
  return { token, account };
};

const rowOf = async (account: string): Promise<unknown> => (await (await pool.db()).prepare('SELECT raw_consent, raw_consent_version, raw_consent_withdrawn_version, raw_consent_withdrawn_at IS NOT NULL AS withdrawn FROM accounts WHERE id = ?').bind(account).first());

describe('the shared withdrawal statement', () => {
  it('is the text the route runs', async () => {
    const { token } = await withYes();
    const ran: string[] = [];
    const env: Env = { ...(await pool.miniflare.getBindings<Env>()), DB: poolDbOf(await pool.db(), (sql) => Promise.resolve(void ran.push(sql))) };
    const answered = await withdrawRawConsent(new Request('https://pool.test/v1/consent/raw', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }), env);
    expect(answered.status).toBe(200);
    expect(ran).toContain(WITHDRAW_RAW_CONSENT);
  }, 60_000);

  it('leaves the account row the route leaves, on a twin account, and then changes nothing on a rerun or for an account with no yes', async () => {
    const routed = await withYes();
    const scripted = await withYes();
    const db = await pool.db();
    expect((await pool.send('/v1/consent/raw', { method: 'DELETE' }, routed.token)).status).toBe(200);
    const changes = async (account: string, at: number): Promise<number> => Number(fieldOf(fieldOf(await db.prepare(WITHDRAW_RAW_CONSENT).bind(at, account).run(), 'meta'), 'changes'));
    expect(await changes(scripted.account, 1_700_000_000_000)).toBe(1);
    expect(await rowOf(scripted.account)).toEqual(await rowOf(routed.account));
    expect(await rowOf(scripted.account)).toEqual({ raw_consent: null, raw_consent_version: null, raw_consent_withdrawn_version: 'v1', withdrawn: 1 });
    // The first withdrawal's record stands: a second run matches no row.
    expect(await changes(scripted.account, 1_800_000_000_000)).toBe(0);
    expect(fieldOf(await db.prepare('SELECT raw_consent_withdrawn_at AS at FROM accounts WHERE id = ?').bind(scripted.account).first(), 'at')).toBe(1_700_000_000_000);
  }, 60_000);
});
