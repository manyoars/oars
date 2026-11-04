import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBundle, type Bundle } from '../../cli/src/sessions/pool-wire.js';
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

const pulled = async (stack: string, token: string): Promise<Bundle> => {
  const { status, json } = await pool.get(`/v1/slices/${stack}`, token);
  expect(status).toBe(200);
  const verified = await verifyBundle(json, pool.signingKey(), stack);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.bundle;
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
    const fit = slice.reads.find((read) => read.family === 'fit' && read.bundle.level === 'shape');
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
    expect((await pool.get('/bundle/2.1.314/0')).status).toBe(401);
  });

  it('says so when the pool has no signing key', async () => {
    const bare = await startPool({ SLICE_SIGNING_KEY: '' });
    try {
      await (await bare.db()).prepare("INSERT INTO accounts (id) VALUES ('acct')").run();
      await (await bare.db()).prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct', ?)").bind(createHash('sha256').update('a-token').digest('hex'), Date.now() + 60_000).run();
      expect(await bare.get('/bundle/2.1.314/0', 'a-token')).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing('SLICE_SIGNING_KEY') } });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe('clusters over the cells of a read', () => {
  const inFreshPool = async (run: (spread: TestPool) => Promise<void>): Promise<void> => {
    const spread = await startPool();
    try {
      await run(spread);
    } finally {
      await spread.dispose();
    }
  };

  const depositOn = async (spread: TestPool, id: string, days: readonly string[]): Promise<string> => {
    const { token } = await spread.signIn('github', stubUser(id));
    await spread.post('/v1/covenant/accept', { version: 'v1' }, token);
    for (const [index, day] of days.entries()) expect((await spread.post('/v1/deposits', sampleSkeleton(`${id}${String(index)}`.padStart(16, '0'), undefined, day), token)).status).toBe(201);
    return token;
  };

  const readsIn = async (spread: TestPool, token: string): Promise<Bundle> => {
    const verified = await verifyBundle((await spread.get('/bundle/2.1.314/0', token)).json, spread.signingKey(), '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    return verified.bundle;
  };

  // Cells split by day, so no single cell here holds more than one account: only the union over a read's cells can reach the floor.
  it('three accounts on three different days serve a read with clusters 3, while their cells stay under the floor', async () => {
    await inFreshPool(async (spread) => {
      await depositOn(spread, '3001', ['2026-11-01']);
      await depositOn(spread, '3002', ['2026-11-02']);
      const token = await depositOn(spread, '3003', ['2026-11-03']);
      const slice = await readsIn(spread, token);
      const fit = slice.reads.find((read) => read.family === 'fit' && read.bundle.level === 'shape');
      expect(fit?.clusters).toBe(3);
      expect(fit?.inputs).toHaveLength(3);
      for (const read of slice.reads) expect(read.clusters).toBe(3);
      expect(slice.cells).toEqual([]);
    });
  }, 60_000);

  it('one account on several days stays one account', async () => {
    await inFreshPool(async (spread) => {
      await depositOn(spread, '3101', ['2026-11-01', '2026-11-02', '2026-11-03']);
      const token = await depositOn(spread, '3102', ['2026-11-04']);
      expect((await readsIn(spread, token)).reads).toEqual([]);
    });
  }, 60_000);
});

describe('a stored row whose day no calendar holds', () => {
  // Inserted past the deposit route, the way a row written before the check, or under a wider vocabulary, would sit there.
  const stored = async (bad: TestPool, account: string, id: string, stacks: readonly string[], day: string): Promise<void> => {
    await (await bad.db()).prepare('INSERT INTO accounts (id) VALUES (?)').bind(account).run();
    await (await bad.db()).prepare('INSERT INTO deposits (account, id, stacks, skeleton) VALUES (?, ?, ?, ?)').bind(account, id, JSON.stringify(stacks), JSON.stringify(sampleSkeleton(id, undefined, day))).run();
  };

  it.each(['2026-99-99', '0000-00-00', '2026-13-01', '2026-02-31'])('%s stops counting and every pull still answers', async (day) => {
    const bad = await startPool();
    try {
      const deposited = async (id: string): Promise<string> => {
        const { token } = await bad.signIn('github', stubUser(id));
        await bad.post('/v1/covenant/accept', { version: 'v1' }, token);
        expect((await bad.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
        return token;
      };
      await deposited('5001');
      await deposited('5002');
      const token = await deposited('5003');

      await stored(bad, 'acct_bad_typescript', '00000000000b0001', ['typescript'], day);
      // A row naming no stack reaches only `all`, which reads every row.
      await stored(bad, 'acct_bad_no_stack', '00000000000b0002', [], day);

      for (const stack of ['all', 'typescript']) {
        const { status, json } = await bad.get(`/v1/slices/${stack}`, token);
        expect(status).toBe(200);
        const verified = await verifyBundle(json, bad.signingKey(), stack);
        if (!verified.ok) throw new Error(verified.reason);
        // The three good accounts still reach the floor, and the two bad rows add nothing to it.
        expect(verified.bundle.reads.length).toBeGreaterThan(0);
        for (const read of verified.bundle.reads) expect(read.clusters).toBe(3);
      }
    } finally {
      await bad.dispose();
    }
  }, 60_000);
});

describe('the client refuses', () => {
  const signed = async (): Promise<{ payload: string; signature: string }> => {
    const { token } = await pool.signIn('github', stubUser('1006'));
    const { json } = await pool.get('/bundle/2.1.314/0', token);
    return { payload: textOf(json, 'payload'), signature: textOf(json, 'signature') };
  };

  it('a tampered payload, a tampered signature, another key, and another stack', async () => {
    const good = await signed();
    expect(fieldOf(await verifyBundle(good, pool.signingKey(), '2.1.314'), 'ok')).toBe(true);
    const tampered = good.payload.replace(/"clusters":\d+/, '"clusters":99');
    expect(tampered).not.toBe(good.payload);
    expect(await verifyBundle({ ...good, payload: tampered }, pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    const flipped = good.signature.startsWith('A') ? `B${good.signature.slice(1)}` : `A${good.signature.slice(1)}`;
    expect(await verifyBundle({ ...good, signature: flipped }, pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle(good, { ...pool.signingKey(), x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'all')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle(good, pool.signingKey(), 'python')).toMatchObject({ ok: false, reason: containing('stack') });
  });

  it('anything that is not a signed slice', async () => {
    expect(await verifyBundle('nope', pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('not a signed slice') });
    expect(await verifyBundle({ payload: 'x', signature: '%%%' }, pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle({ payload: 'x', signature: 'AAAA' }, { kty: 'nope', crv: 'nope', x: 'nope' }, 'all')).toMatchObject({ ok: false, reason: containing('signature') });
  });
});
