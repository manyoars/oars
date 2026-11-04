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

const VERSION = '2.1.314';

const pulled = async (token: string, version = VERSION): Promise<Bundle> => {
  const { status, json } = await pool.get(`/bundle/${version}/0`, token);
  expect(status).toBe(200);
  const verified = await verifyBundle(json, pool.signingKey(), version);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.bundle;
};

describe('a bundle over five accounts', () => {
  it('serves nothing at four accounts and a read at the fifth, with clusters counted by account', async () => {
    const first = await depositor('1001');
    expect((await pulled(first)).reads).toEqual([]);
    expect((await pulled(first)).cells).toEqual([]);

    const second = await depositor('1002');
    expect((await pulled(second)).reads).toEqual([]);

    // A second session from one account is still one cluster.
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a1002'), second)).status).toBe(201);
    expect((await pulled(second)).reads).toEqual([]);

    await depositor('1003');
    await depositor('1004');
    const four = await pulled(first);
    expect(four.reads).toEqual([]);
    expect(four.cells).toEqual([]);

    await depositor('1008');
    const bundle = await pulled(first);
    expect(bundle.reads.length).toBeGreaterThan(0);
    for (const read of bundle.reads) expect(read.clusters).toBe(5);
    expect(new Set(bundle.reads.map((read) => read.family)).has('fit')).toBe(true);
    expect(bundle.cells.length).toBeGreaterThan(0);
    for (const cell of bundle.cells) expect(cell.clusters).toBe(5);
    const fit = bundle.reads.find((read) => read.family === 'fit' && read.slice.level === 'shape');
    expect(fit?.value).toMatchObject({ failed: 0 });
    // Six deposits of two steps each.
    expect(fit?.n).toBe(12);
  });

  it('serves rule 3 strata pool-wide: a language over the floor is served, whatever the stack of the rest', async () => {
    for (const id of ['1011', '1012', '1013', '1014']) await depositor(id, { languages: ['python'] });
    const bundle = await pulled(await depositor('1015', { languages: ['python'] }));
    expect(bundle.strata.find((cell) => cell.dimension === 'language' && cell.value === 'python')).toMatchObject({ clusters: 5 });
    expect(bundle.strata.find((cell) => cell.dimension === 'language' && cell.value === 'typescript')).toMatchObject({ clusters: 5 });
    expect(bundle.reads.length).toBeGreaterThan(0);
  });

  it('withholds a language held by four accounts', async () => {
    const fresh = await startPool();
    try {
      const sign = async (id: string): Promise<string> => {
        const { token } = await fresh.signIn('github', stubUser(id));
        await fresh.post('/v1/covenant/accept', { version: 'v1' }, token);
        expect((await fresh.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), { languages: ['rust'] }), token)).status).toBe(201);
        return token;
      };
      const strataOf = async (token: string): Promise<Bundle['strata']> => {
        const verified = await verifyBundle((await fresh.get(`/bundle/${VERSION}/0`, token)).json, fresh.signingKey(), VERSION);
        if (!verified.ok) throw new Error(verified.reason);
        return verified.bundle.strata;
      };
      for (const id of ['2001', '2002', '2003']) await sign(id);
      const token = await sign('2004');
      expect(await strataOf(token)).toEqual([]);
      expect((await strataOf(await sign('2005'))).find((cell) => cell.value === 'rust')).toMatchObject({ clusters: 5 });
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  it('names no stack in any key of a response', async () => {
    const { json } = await pool.get(`/bundle/${VERSION}/0`, await depositor('1006'));
    const walk = (value: unknown, path: string): string[] => {
      if (typeof value !== 'object' || value === null) return [];
      return Object.entries(value).flatMap(([key, held]) => [...(/stack|language|framework|repoFiles/i.test(key) ? [`${path}.${key}`] : []), ...walk(held, `${path}.${key}`)]);
    };
    const payload: unknown = JSON.parse(textOf(json, 'payload'));
    expect(walk(payload, 'bundle')).toEqual([]);
    // A stack value may sit only in the strata cells (rule 3): everywhere else the bundle is the same for every stack.
    const strata = fieldOf(payload, 'strata');
    expect(JSON.stringify(strata)).toContain('typescript');
    expect(JSON.stringify({ ...(typeof payload === 'object' && payload !== null ? payload : {}), strata: undefined })).not.toContain('typescript');
    expect(typeof json === 'object' && json !== null ? Object.keys(json).sort() : []).toEqual(['payload', 'signature']);
  });

  it('turns away a caller with no credential, and names a version outside the vocabulary', async () => {
    const { token } = await pool.signIn('github', stubUser('1005'));
    expect((await pool.get('/bundle/2.1.314/0')).status).toBe(401);
    expect((await pool.get('/bundle/2.1.314/0', 'not-a-token')).status).toBe(401);
    expect(await pool.get('/bundle/acme/0', token)).toMatchObject({ status: 400, json: { error: 'unknown_harness_version', field: 'harnessVersion' } });
    expect(await pool.get('/bundle/2.1.314/9', token)).toMatchObject({ status: 400, json: { error: 'unknown_vocab_version', field: 'vocabVersion' } });
  });

  it('has no route by stack, and no other path shape', async () => {
    const { token } = await pool.signIn('github', stubUser('1007'));
    expect((await pool.get('/v1/slices/typescript', token)).status).toBe(404);
    expect((await pool.get('/v1/slices/all', token)).status).toBe(404);
    expect((await pool.get('/bundle/2.1.314', token)).status).toBe(404);
    expect((await pool.get('/bundle/2.1.314/0/typescript', token)).status).toBe(404);
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
  it('five accounts on five different days serve a read with clusters 5, while their cells stay under the floor', async () => {
    await inFreshPool(async (spread) => {
      await depositOn(spread, '3001', ['2026-11-01']);
      await depositOn(spread, '3002', ['2026-11-02']);
      await depositOn(spread, '3003', ['2026-11-03']);
      expect((await readsIn(spread, await depositOn(spread, '3004', ['2026-11-04']))).reads).toEqual([]);
      const token = await depositOn(spread, '3005', ['2026-11-05']);
      const bundle = await readsIn(spread, token);
      const fit = bundle.reads.find((read) => read.family === 'fit' && read.slice.level === 'shape');
      expect(fit?.clusters).toBe(5);
      expect(fit?.inputs).toHaveLength(5);
      for (const read of bundle.reads) expect(read.clusters).toBe(5);
      expect(bundle.cells).toEqual([]);
    });
  }, 60_000);

  // Section 4 rule 1: a live read's floor counts the sliced day's cells and never its baseline's, or one account on a day would ride on the week before it.
  it('one account on day D with five on D-1 serves D-1 and not D', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['3201', '3202', '3203', '3204', '3205']) await depositOn(spread, id, ['2026-11-02']);
      const token = await depositOn(spread, '3206', ['2026-11-03']);
      const live = (await readsIn(spread, token)).reads.filter((read) => read.family === 'live');
      expect([...new Set(live.map((read) => fieldOf(read.slice, 'day')))]).toEqual(['2026-11-02']);
      for (const read of live) expect(read.clusters).toBe(5);
    });
  }, 60_000);

  it('five accounts on D and one in the baseline serve D with a null baseline', async () => {
    await inFreshPool(async (spread) => {
      await depositOn(spread, '3301', ['2026-11-02']);
      for (const id of ['3302', '3303', '3304', '3305']) await depositOn(spread, id, ['2026-11-03']);
      const token = await depositOn(spread, '3306', ['2026-11-03']);
      const day = (await readsIn(spread, token)).reads.filter((read) => read.family === 'live' && fieldOf(read.slice, 'day') === '2026-11-03');
      expect(day.length).toBeGreaterThan(0);
      for (const read of day) {
        expect(read.clusters).toBe(5);
        expect(read.value).toMatchObject({ baseline: null, ratio: null });
        expect(fieldOf(read.value, 'share')).not.toBeNull();
      }
    });
  }, 60_000);

  it('five accounts on D and five in the baseline serve D with the baseline', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['3401', '3402', '3403', '3404', '3405']) await depositOn(spread, id, ['2026-11-02']);
      for (const id of ['3406', '3407', '3408', '3409']) await depositOn(spread, id, ['2026-11-03']);
      const token = await depositOn(spread, '3410', ['2026-11-03']);
      const day = (await readsIn(spread, token)).reads.filter((read) => read.family === 'live' && fieldOf(read.slice, 'day') === '2026-11-03');
      expect(day.length).toBeGreaterThan(0);
      for (const read of day) expect(fieldOf(read.value, 'baseline')).not.toBeNull();
    });
  }, 60_000);

  it('one account on several days stays one account', async () => {
    await inFreshPool(async (spread) => {
      // Four days, so a count per cell would reach 5 with the one account that follows.
      await depositOn(spread, '3101', ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
      const token = await depositOn(spread, '3102', ['2026-11-04']);
      expect((await readsIn(spread, token)).reads).toEqual([]);
    });
  }, 60_000);
});

describe('a stored row whose day no calendar holds', () => {
  // Inserted past the deposit route, the way a row written before the check, or under a wider vocabulary, would sit there.
  const stored = async (bad: TestPool, account: string, id: string, day: string): Promise<void> => {
    await (await bad.db()).prepare('INSERT INTO accounts (id) VALUES (?)').bind(account).run();
    await (await bad.db()).prepare('INSERT INTO deposits (account, id, skeleton) VALUES (?, ?, ?)').bind(account, id, JSON.stringify(sampleSkeleton(id, undefined, day))).run();
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
      await deposited('5003');
      await deposited('5004');
      const token = await deposited('5005');

      await stored(bad, 'acct_bad_one', '00000000000b0001', day);
      await stored(bad, 'acct_bad_two', '00000000000b0002', day);

      const { status, json } = await bad.get(`/bundle/${VERSION}/0`, token);
      expect(status).toBe(200);
      const verified = await verifyBundle(json, bad.signingKey(), VERSION);
      if (!verified.ok) throw new Error(verified.reason);
      // The five good accounts still reach the floor, and the two bad rows add nothing to it.
      expect(verified.bundle.reads.length).toBeGreaterThan(0);
      for (const read of verified.bundle.reads) expect(read.clusters).toBe(5);
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

  it('a tampered payload, a tampered signature, another key, and another harness version', async () => {
    const good = await signed();
    expect(fieldOf(await verifyBundle(good, pool.signingKey(), '2.1.314'), 'ok')).toBe(true);
    const tampered = good.payload.replace(/"clusters":\d+/, '"clusters":99');
    expect(tampered).not.toBe(good.payload);
    expect(await verifyBundle({ ...good, payload: tampered }, pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    const flipped = good.signature.startsWith('A') ? `B${good.signature.slice(1)}` : `A${good.signature.slice(1)}`;
    expect(await verifyBundle({ ...good, signature: flipped }, pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle(good, { ...pool.signingKey(), x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle(good, pool.signingKey(), '2.2.0')).toMatchObject({ ok: false, reason: containing('harness version') });
  });

  it('anything that is not a signed bundle', async () => {
    expect(await verifyBundle('nope', pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('not a signed bundle') });
    expect(await verifyBundle({ payload: 'x', signature: '%%%' }, pool.signingKey(), '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle({ payload: 'x', signature: 'AAAA' }, { kty: 'nope', crv: 'nope', x: 'nope' }, '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
  });
});
