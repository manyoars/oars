import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySlice, type Slice } from '../../cli/src/sessions/pool-wire.js';
import { sampleSkeleton } from './sample.js';
import { containing, fieldOf, startPool, stubUser, type TestPool, textOf } from './test-pool.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const depositor = async (id: string, stack: { languages: string[] } = { languages: ['typescript'] }): Promise<string> => {
  const { token } = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
  expect((await pool.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), stack), token)).status).toBe(201);
  return token;
};

const pulled = async (stack: string, token: string): Promise<Slice> => {
  const { status, json } = await pool.get(`/v1/slices/${stack}`, token);
  expect(status).toBe(200);
  const verified = await verifySlice(json, pool.signingKey(), stack);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.slice;
};

describe('a slice over three accounts', () => {
  it('serves a read only at the third account, with clusters counted by account', async () => {
    const first = await depositor('1001');
    expect((await pulled('all', first)).reads).toEqual([]);
    expect((await pulled('all', first)).cells).toEqual([]);

    const second = await depositor('1002');
    expect((await pulled('all', second)).reads).toEqual([]);

    // A second session from one account is still one cluster.
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a1002'), second)).status).toBe(201);
    expect((await pulled('all', second)).reads).toEqual([]);

    await depositor('1003');
    const slice = await pulled('all', first);
    expect(slice.reads.length).toBeGreaterThan(0);
    for (const read of slice.reads) expect(read.clusters).toBe(3);
    expect(new Set(slice.reads.map((read) => read.family)).has('fit')).toBe(true);
    expect(slice.cells.length).toBeGreaterThan(0);
    for (const cell of slice.cells) expect(cell.clusters).toBe(3);
    const fit = slice.reads.find((read) => read.family === 'fit' && read.slice.level === 'shape');
    expect(fit?.value).toMatchObject({ failed: 0 });
    // Four deposits of two steps each.
    expect(fit?.n).toBe(8);
  });

  it('cuts by stack: an account on another stack lifts nothing here', async () => {
    const token = await depositor('1004', { languages: ['python'] });
    expect((await pulled('python', token)).reads).toEqual([]);
    expect((await pulled('typescript', token)).reads.length).toBeGreaterThan(0);
  });

  it('names a stack outside the vocabulary, and turns away a caller with no account', async () => {
    const { token } = await pool.signIn('github', stubUser('1005'));
    expect(await pool.get('/v1/slices/acme', token)).toMatchObject({ status: 400, json: { error: 'unknown_stack', field: 'stack' } });
    expect((await pool.get('/v1/slices/all')).status).toBe(401);
  });

  it('says so when the pool has no signing key', async () => {
    const bare = await startPool({ SLICE_SIGNING_KEY: '' });
    try {
      await (await bare.db()).prepare("INSERT INTO accounts (id) VALUES ('acct')").run();
      await (await bare.db()).prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct', ?)").bind(createHash('sha256').update('a-token').digest('hex'), Date.now() + 60_000).run();
      expect(await bare.get('/v1/slices/all', 'a-token')).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing('SLICE_SIGNING_KEY') } });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe('the client refuses', () => {
  const signed = async (): Promise<{ payload: string; signature: string }> => {
    const { token } = await pool.signIn('github', stubUser('1006'));
    const { json } = await pool.get('/v1/slices/all', token);
    return { payload: textOf(json, 'payload'), signature: textOf(json, 'signature') };
  };

  it('a tampered payload, a tampered signature, another key, and another stack', async () => {
    const good = await signed();
    expect(fieldOf(await verifySlice(good, pool.signingKey(), 'all'), 'ok')).toBe(true);
    const tampered = good.payload.replace(/"clusters":\d+/, '"clusters":99');
    expect(tampered).not.toBe(good.payload);
    expect(await verifySlice({ ...good, payload: tampered }, pool.signingKey(), 'all')).toMatchObject({ ok: false, reason: containing('signature') });
    const flipped = good.signature.startsWith('A') ? `B${good.signature.slice(1)}` : `A${good.signature.slice(1)}`;
    expect(await verifySlice({ ...good, signature: flipped }, pool.signingKey(), 'all')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifySlice(good, { ...pool.signingKey(), x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'all')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifySlice(good, pool.signingKey(), 'python')).toMatchObject({ ok: false, reason: containing('stack') });
  });

  it('anything that is not a signed slice', async () => {
    expect(await verifySlice('nope', pool.signingKey(), 'all')).toMatchObject({ ok: false, reason: containing('not a signed slice') });
    expect(await verifySlice({ payload: 'x', signature: '%%%' }, pool.signingKey(), 'all')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifySlice({ payload: 'x', signature: 'AAAA' }, { kty: 'nope', crv: 'nope', x: 'nope' }, 'all')).toMatchObject({ ok: false, reason: containing('signature') });
  });
});
