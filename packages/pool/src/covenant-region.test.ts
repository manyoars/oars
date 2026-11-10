// Where the person is (GDPR Article 27, UK GDPR Article 27): an acceptance asks "Are you in the EU, the EEA, or the UK?" and stores the answer with Cloudflare's country for the request; a deposit stores its request's country; and while PROTECTED_REGIONS_OPEN is not `1` an acceptance from those regions is refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTECTED_REGIONS } from './covenant.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf } from './test-covenant-texts.js';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

/** Miniflare takes the request's `cf` from this header, as Cloudflare sets it on a live request. */
const from = (country?: string): { [name: string]: string } => ({ 'MF-CF-Blob': JSON.stringify(country === undefined ? {} : { country }) });

/** An acceptance that states everything but the answer. */
const unanswered = (): object => Object.fromEntries(Object.entries(acceptanceOf('v1')).filter(([name]) => name !== 'euEeaUk'));

const MESSAGE = 'Many Oars cannot take deposits from the EU, the EEA, or the UK yet. If you are not there, write to privacy@manyoars.com.';

const rowOf = async (pool: TestPool, account: string): Promise<unknown> =>
  (await pool.db()).prepare('SELECT eu_eea_uk, request_country FROM covenant_acceptances WHERE account = ?').bind(account).first();

const countOf = async (pool: TestPool, account: string): Promise<unknown> =>
  (await pool.db()).prepare('SELECT (SELECT COUNT(*) FROM covenant_acceptances WHERE account = ?) AS n').bind(account).first('n');

describe('the regions the pool does not take acceptances from', () => {
  it('lists the EU 27 and the EU territory with its own code, Iceland, Liechtenstein, Norway, and the UK', () => {
    expect(PROTECTED_REGIONS.size).toBe(38);
    for (const code of ['AT', 'DE', 'FR', 'IE', 'SE', 'IS', 'LI', 'NO', 'GB', 'RE', 'AX', 'GF', 'GP', 'MQ', 'YT', 'MF']) expect(PROTECTED_REGIONS.has(code)).toBe(true);
    for (const code of ['US', 'CH', 'CA', 'UK', 'T1']) expect(PROTECTED_REGIONS.has(code)).toBe(false);
  });
});

describe('with PROTECTED_REGIONS_OPEN unset', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('refuses a person who answers yes, whatever the request country, and writes nothing', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6601'));
    for (const country of ['US', 'DE', undefined]) {
      expect(await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'yes' }, token, from(country))).toEqual({ status: 403, json: { error: 'region_closed', message: MESSAGE } });
    }
    expect(await countOf(pool, account)).toBe(0);
    expect(await pool.get('/v1/covenant', token)).toMatchObject({ json: { accepted: false } });
  });

  it('refuses a request from a listed country even when the person answers no', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6602'));
    for (const country of ['DE', 'GB', 'NO', 'IS', 'LI']) {
      expect(await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'no' }, token, from(country))).toMatchObject({ status: 403, json: { error: 'region_closed' } });
    }
    expect(await countOf(pool, account)).toBe(0);
  });

  it('answers 400 for a missing or unknown answer, naming the field', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6603'));
    expect(await pool.post('/v1/covenant/accept', unanswered(), token, from('US'))).toMatchObject({ status: 400, json: { error: 'missing_field', field: 'euEeaUk' } });
    for (const answer of ['maybe', 'YES', '', 1]) {
      expect(await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: answer }, token, from('US'))).toMatchObject({ status: 400, json: { field: 'euEeaUk' } });
    }
    expect(await countOf(pool, account)).toBe(0);
  });

  it('stores the answer and the request country of an acceptance from elsewhere', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6604'));
    expect((await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'no' }, token, from('CH'))).status).toBe(200);
    const row = await rowOf(pool, account);
    expect(fieldOf(row, 'eu_eea_uk')).toBe('no');
    expect(fieldOf(row, 'request_country')).toBe('CH');
  });

  it('stores no country when Cloudflare gives none, and accepts', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6605'));
    expect((await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'no' }, token, from())).status).toBe(200);
    const row = await rowOf(pool, account);
    expect(fieldOf(row, 'eu_eea_uk')).toBe('no');
    expect(fieldOf(row, 'request_country')).toBeNull();
  });

  it('stores the country of a deposit and never refuses one by country', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6606'));
    expect((await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'no' }, token, from('US'))).status).toBe(200);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000006606'), token, from('DE'))).status).toBe(201);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000006607'), token, from())).status).toBe(201);
    const rows = (await (await pool.db()).prepare('SELECT id, request_country FROM deposits WHERE account = ? ORDER BY id').bind(account).all()).results;
    expect(rows.map((row) => [textOf(row, 'id'), fieldOf(row, 'request_country')])).toEqual([
      ['0000000000006606', 'DE'],
      ['0000000000006607', null],
    ]);
  });
});

describe('with PROTECTED_REGIONS_OPEN set to 1', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool({ PROTECTED_REGIONS_OPEN: '1' });
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('accepts a yes and a listed country, and stores both', async () => {
    const { token, account } = await pool.signIn('github', stubUser('6611'));
    expect((await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'yes' }, token, from('DE'))).status).toBe(200);
    const row = await rowOf(pool, account);
    expect(fieldOf(row, 'eu_eea_uk')).toBe('yes');
    expect(fieldOf(row, 'request_country')).toBe('DE');
  });

  it('still needs an answer', async () => {
    const { token } = await pool.signIn('github', stubUser('6612'));
    expect(await pool.post('/v1/covenant/accept', unanswered(), token, from('DE'))).toMatchObject({ status: 400, json: { field: 'euEeaUk' } });
  });
});

describe('with PROTECTED_REGIONS_OPEN set to anything but 1', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool({ PROTECTED_REGIONS_OPEN: 'true' });
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('stays closed', async () => {
    const { token } = await pool.signIn('github', stubUser('6621'));
    expect(await pool.post('/v1/covenant/accept', { ...acceptanceOf('v1'), euEeaUk: 'no' }, token, from('FR'))).toMatchObject({ status: 403, json: { error: 'region_closed' } });
  });
});
