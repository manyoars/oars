import { createHash, webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESSES, verifyBundle, VOCAB_VERSION, type Bundle } from '../../cli/src/sessions/pool-wire.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { etagOf } from './bundle.js';
import { DEFAULT_FLOORS, floorsOf } from './floors.js';
import { SERVED } from './derive.js';
import { sampleSkeleton, withPairs } from './sample.js';
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

const fetched = async (token: string, version = VERSION): Promise<Bundle> => {
  const { status, json } = await pool.get(`/bundle/claude-code/${version}/${VOCAB_VERSION}`, token);
  expect(status).toBe(200);
  const verified = await verifyBundle(json, pool.pinned(), 'claude-code', version);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.bundle;
};

describe('a bundle over five accounts', () => {
  it('serves nothing at four accounts and a read at the fifth, with clusters counted by account', async () => {
    const first = await depositor('1001');
    expect((await fetched(first)).reads).toEqual([]);
    expect((await fetched(first)).cells).toEqual([]);

    const second = await depositor('1002');
    expect((await fetched(second)).reads).toEqual([]);

    // A second session from one account is still one cluster.
    expect((await pool.post('/v1/deposits', sampleSkeleton('00000000000a1002'), second)).status).toBe(201);
    expect((await fetched(second)).reads).toEqual([]);

    await depositor('1003');
    await depositor('1004');
    const four = await fetched(first);
    expect(four.reads).toEqual([]);
    expect(four.cells).toEqual([]);
    expect(four.motifs).toEqual([]);

    await depositor('1008');
    const bundle = await fetched(first);
    expect(bundle.reads.length).toBeGreaterThan(0);
    for (const read of bundle.reads) expect(read.clusters).toBe(5);
    expect(new Set(bundle.reads.map((read) => read.family)).has('fit')).toBe(true);
    expect(bundle.cells.length).toBeGreaterThan(0);
    for (const cell of bundle.cells) expect(cell.clusters).toBe(5);
    expect(bundle.motifs.length).toBeGreaterThan(0);
    // A bundle is one harness version's: the five accounts deposited on 2.1.314, so 2.2.0 holds none of their version cells. The (name, platform, shell) cells name no version, so it holds those and the reads over them.
    const other = await fetched(first, '2.2.0');
    expect(other.cells.every((cell) => cell.frameBucket.startsWith('env:'))).toBe(true);
    expect(other.cells.length).toBeGreaterThan(0);
    expect(other.reads.every((read) => read.family === 'fit' && read.slice.platform !== undefined)).toBe(true);
    expect(other.reads.length).toBeGreaterThan(0);
    // No cell of its own: the bucket takes the whole pool's last day, the Monday of the fixture's week.
    expect(other.asOf.day).toBe('2026-10-26');
    expect(other.motifs.map(({ motifId }) => motifId).sort()).toEqual([...new Set(other.cells.map(({ motifId }) => motifId))].sort());
    // Strata run over every harness version (rule 3), so the bundle for a version with no cells of its own holds the same ones.
    expect(bundle.strata.length).toBeGreaterThan(0);
    expect(other.strata).toEqual(bundle.strata);
    const fit = bundle.reads.find((read) => read.family === 'fit' && read.slice.level === 'shape');
    expect(fit?.value).toMatchObject({ failed: 0 });
    // Six deposits of two steps each.
    expect(fit?.n).toBe(12);
  });

  it('serves rule 3 strata pool-wide: a language over the floor is served, whatever the stack of the rest', async () => {
    for (const id of ['1011', '1012', '1013', '1014']) await depositor(id, { languages: ['python'] });
    const bundle = await fetched(await depositor('1015', { languages: ['python'] }));
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
        const verified = await verifyBundle((await fresh.get(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token)).json, fresh.pinned(), 'claude-code', VERSION);
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

  // Rule 3's three dimensions are separate lines in the bundle: a framework and a repo size reach the floor the way a language does, and a session counts once per skeleton.
  it('serves a framework and a repo size at five accounts and neither at four, and keeps both out of everything but the strata', async () => {
    const fresh = await startPool();
    try {
      const stack: Parameters<typeof sampleSkeleton>[1] = { languages: ['rust'], frameworks: ['astro'], size: 'xl' };
      const sign = async (id: string, twice = false): Promise<string> => {
        const { token } = await fresh.signIn('github', stubUser(id));
        await fresh.post('/v1/covenant/accept', { version: 'v1' }, token);
        expect((await fresh.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), stack), token)).status).toBe(201);
        // A second session from the same account: a second session in the tally, still one cluster.
        if (twice) expect((await fresh.post('/v1/deposits', sampleSkeleton(`a${id}`.padStart(16, '0'), stack), token)).status).toBe(201);
        return token;
      };
      const payloadOf = async (token: string): Promise<{ strata: Bundle['strata']; outside: string }> => {
        const { json } = await fresh.get(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
        const verified = await verifyBundle(json, fresh.pinned(), 'claude-code', VERSION);
        if (!verified.ok) throw new Error(verified.reason);
        return { strata: verified.bundle.strata, outside: JSON.stringify({ ...verified.bundle, strata: undefined }) };
      };
      await sign('6001', true);
      for (const id of ['6002', '6003']) await sign(id);
      const four = await payloadOf(await sign('6004'));
      expect(four.strata).toEqual([]);
      const five = await payloadOf(await sign('6005'));
      expect(five.strata.filter((cell) => cell.value !== 'rust').map((cell) => `${cell.dimension}/${cell.value}`)).toEqual(['framework/astro', 'repoFiles/xl']);
      // Six sessions from five accounts: the first account's second session counts toward sessions and not toward clusters.
      for (const cell of five.strata) expect(cell).toMatchObject({ sessions: 6, clusters: 5 });
      for (const value of ['"rust"', 'astro', '"xl"']) expect(five.outside).not.toContain(value);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  // Rule 3's two pairs are strata of their own: (language, share) and (repo size, explore bucket) reach the floor the way a single value does, and a pair never rides in any cell.
  it('serves each pair at five accounts and holds it at four, and keeps both pairs out of everything but the strata', async () => {
    const fresh = await startPool();
    try {
      const sign = async (id: string): Promise<string> => {
        const { token } = await fresh.signIn('github', stubUser(id));
        await fresh.post('/v1/covenant/accept', { version: 'v1' }, token);
        const skeleton = withPairs(sampleSkeleton(id.padStart(16, '0'), { languages: ['rust'], size: 'xl' }), [{ language: 'rust', languageShare: 'over-50' }], 7);
        expect((await fresh.post('/v1/deposits', skeleton, token)).status).toBe(201);
        return token;
      };
      const payloadOf = async (token: string): Promise<{ pairs: string[]; outside: string }> => {
        const { json } = await fresh.get(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
        const verified = await verifyBundle(json, fresh.pinned(), 'claude-code', VERSION);
        if (!verified.ok) throw new Error(verified.reason);
        const { strata } = verified.bundle;
        return { pairs: strata.filter((cell) => cell.dimension === 'languageShare' || cell.dimension === 'repoFilesExplore').map((cell) => `${cell.dimension}/${cell.value} ${String(cell.clusters)}`), outside: JSON.stringify({ ...verified.bundle, strata: undefined }) };
      };
      for (const id of ['7001', '7002', '7003']) await sign(id);
      expect((await payloadOf(await sign('7004'))).pairs).toEqual([]);
      const five = await payloadOf(await sign('7005'));
      expect(five.pairs).toEqual(['languageShare/rust/over-50 5', 'repoFilesExplore/xl/7 5']);
      for (const value of ['over-50', 'xl/7']) expect(five.outside).not.toContain(value);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  it('names no stack in any key of a response', async () => {
    const { json } = await pool.get(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, await depositor('1006'));
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
    expect(typeof json === 'object' && json !== null ? Object.keys(json).sort() : []).toEqual(['kid', 'payload', 'signature']);
  });

  it('turns away a caller with no credential, and names a version outside the vocabulary', async () => {
    const { token } = await pool.signIn('github', stubUser('1005'));
    expect((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`)).status).toBe(401);
    expect((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, 'not-a-token')).status).toBe(401);
    expect(await pool.get(`/bundle/claude-code/acme/${VOCAB_VERSION}`, token)).toMatchObject({ status: 400, json: { error: 'unknown_harness_version', field: 'harnessVersion' } });
    // The literal stands in for a private version, and publicVersion hands it back unchanged, so only the guard keeps the pooled private bucket from being served by name.
    expect(await pool.get(`/bundle/claude-code/%3Cliteral%3E/${VOCAB_VERSION}`, token)).toMatchObject({ status: 400, json: { error: 'unknown_harness_version', field: 'harnessVersion' } });
    expect(await pool.get('/bundle/claude-code/2.1.314/9', token)).toMatchObject({ status: 400, json: { error: 'unknown_vocab_version', field: 'vocabVersion' } });
  });

  it('has no route by stack, and no other path shape', async () => {
    const { token } = await pool.signIn('github', stubUser('1007'));
    expect((await pool.get('/v1/slices/typescript', token)).status).toBe(404);
    expect((await pool.get('/v1/slices/all', token)).status).toBe(404);
    expect((await pool.get('/bundle/2.1.314', token)).status).toBe(404);
    expect((await pool.get('/bundle/claude-code/2.1.314/0/typescript', token)).status).toBe(404);
  });

  it('refuses a request that names no harness or one this pool does not serve, in the route error form', async () => {
    const { token } = await pool.signIn('github', stubUser('1008'));
    // The route before the harness segment, `/bundle/<harnessVersion>/<vocabVersion>`, is refused by name, not served as a default.
    expect(await pool.get(`/bundle/2.1.314/${VOCAB_VERSION}`, token)).toMatchObject({ status: 400, json: { error: 'harness_required', field: 'harness' } });
    expect(await pool.get(`/bundle//2.1.314/${VOCAB_VERSION}`, token)).toMatchObject({ status: 400, json: { error: 'unknown_harness', field: 'harness' } });
    expect(await pool.get(`/bundle/acme/2.1.314/${VOCAB_VERSION}`, token)).toMatchObject({ status: 400, json: { error: 'unknown_harness', field: 'harness' } });
    // A query string does not name the harness any more.
    expect(await pool.get(`/bundle/2.1.314/${VOCAB_VERSION}?harness=cursor`, token)).toMatchObject({ status: 400, json: { error: 'harness_required' } });
    // Every harness the client names is served (an empty bundle for one nobody deposited on).
    for (const harness of HARNESSES) expect((await pool.get(`/bundle/${harness}/2.1.314/${VOCAB_VERSION}`, token)).status).toBe(200);
    expect(await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`)).toMatchObject({ status: 401 });
    // The old path is named before any credential is read, so a stale client with no token is told what to send.
    expect(await pool.get(`/bundle/2.1.314/${VOCAB_VERSION}`)).toMatchObject({ status: 400, json: { error: 'harness_required', field: 'harness' } });
  });

  it('says so when the pool has no signing key', async () => {
    const bare = await startPool({ BUNDLE_SIGNING_KEY: '' });
    try {
      await (await bare.db()).prepare("INSERT INTO accounts (id) VALUES ('acct')").run();
      await (await bare.db()).prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct', ?)").bind(createHash('sha256').update('a-token').digest('hex'), Date.now() + 60_000).run();
      expect(await bare.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, 'a-token')).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing('BUNDLE_SIGNING_KEY') } });
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
    const verified = await verifyBundle((await spread.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token)).json, spread.pinned(), 'claude-code', '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    return verified.bundle;
  };

  // A non-live cell is a week (rule 6), so five accounts on five days of one week share each week cell and reach the floor there, while a `live` cell is a day and holds one of them. A read's
  // `clusters` is the largest held count among its cells, with no union over accounts: the pool keeps no per-account record on the fetch path.
  it('five accounts on five days of one week serve the week reads at 5 clusters and no live read', async () => {
    await inFreshPool(async (spread) => {
      for (const [index, day] of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].entries()) await depositOn(spread, `300${String(index + 1)}`, [day]);
      const token = await depositOn(spread, '3005', ['2026-10-30']);
      const bundle = await readsIn(spread, token);
      expect(bundle.reads.length).toBeGreaterThan(0);
      expect(bundle.reads.filter((read) => read.family === 'live')).toEqual([]);
      for (const read of bundle.reads) expect(read.clusters).toBe(5);
      expect(bundle.cells.length).toBeGreaterThan(0);
      expect(bundle.cells.every((cell) => cell.grain === 'week' && cell.day === '2026-10-26')).toBe(true);
    });
  }, 60_000);

  it('five accounts in five different weeks serve no read: each week cell holds one cluster and a read takes the largest', async () => {
    await inFreshPool(async (spread) => {
      for (const [index, day] of ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].entries()) await depositOn(spread, `310${String(index + 1)}`, [day]);
      const token = await depositOn(spread, '3105', ['2026-11-02']);
      const bundle = await readsIn(spread, token);
      expect(bundle.reads).toEqual([]);
      expect(bundle.cells).toEqual([]);
      expect(bundle.motifs).toEqual([]);
    });
  }, 60_000);

  // Section 4 rule 1: a live read's floor counts the sliced day's cells and never its baseline's, or one account on a day would ride on the week before it. Two days of one week are not a baseline but the
  // week's own parts: the week at 6 accounts is served, and with a sub-floor day beside it the smallest served day (D-1, at 5) is withheld too, so the week less its served days is a sum over two days.
  it('one account on day D with five on D-1 serves the week and neither day', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['3201', '3202', '3203', '3204', '3205']) await depositOn(spread, id, ['2026-11-02']);
      const token = await depositOn(spread, '3206', ['2026-11-03']);
      const bundle = await readsIn(spread, token);
      expect(bundle.reads.filter((read) => read.family === 'live' || read.family === 'tool-day')).toEqual([]);
      expect(bundle.cells.length).toBeGreaterThan(0);
      expect(bundle.cells.every((cell) => cell.grain === 'week')).toBe(true);
      for (const read of bundle.reads.filter((read) => read.family === 'fit')) expect(read.clusters).toBe(6);
    });
  }, 60_000);

  // The baseline is the days before D, here a Sunday of the week before, so it is not a part of D's own week.
  it('five accounts on D and one in the baseline serve D with a null baseline', async () => {
    await inFreshPool(async (spread) => {
      await depositOn(spread, '3301', ['2026-11-01']);
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

  it('five accounts on D and four in the baseline serve D with a null baseline', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['3501', '3502', '3503', '3504']) await depositOn(spread, id, ['2026-11-01']);
      for (const id of ['3506', '3507', '3508', '3509']) await depositOn(spread, id, ['2026-11-03']);
      const token = await depositOn(spread, '3510', ['2026-11-03']);
      const day = (await readsIn(spread, token)).reads.filter((read) => read.family === 'live' && fieldOf(read.slice, 'day') === '2026-11-03');
      expect(day.length).toBeGreaterThan(0);
      for (const read of day) expect(read.value).toMatchObject({ baseline: null, ratio: null });
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

  // The tool-day read is a day's cells, so its floor counts within its day like a live read's: five accounts on D serve D, and one account on a day of the week before serves nothing for that day.
  it('five accounts on a day serve its tool-day reads at 5 clusters, and one account on a day of the week before serves none for that day', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['3601', '3602', '3603', '3604', '3605']) await depositOn(spread, id, ['2026-11-02']);
      const token = await depositOn(spread, '3606', ['2026-10-28']);
      const toolDay = (await readsIn(spread, token)).reads.filter((read) => read.family === 'tool-day');
      expect(toolDay.length).toBeGreaterThan(0);
      expect([...new Set(toolDay.map((read) => fieldOf(read.slice, 'day')))]).toEqual(['2026-11-02']);
      for (const read of toolDay) {
        expect(read.clusters).toBe(5);
        expect(read.inputs.length).toBeGreaterThan(0);
      }
      // The fixture's five accounts each settle two clean shell calls on the day: ten steps, none failed, and the one shape is the whole day.
      const [shell, ...rest] = toolDay;
      expect(rest).toEqual([]);
      const value = shell?.value;
      expect(['failureRate', 'failed', 'share', 'steps'].map((key) => fieldOf(value, key))).toEqual([0, 0, 1, 10]);
    });
  }, 60_000);

  it('four accounts on a day serve no tool-day read', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['3701', '3702', '3703']) await depositOn(spread, id, ['2026-11-02']);
      const token = await depositOn(spread, '3704', ['2026-11-02']);
      expect((await readsIn(spread, token)).reads.filter((read) => read.family === 'tool-day')).toEqual([]);
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

describe('a damaged ledger row', () => {
  // Written past the deposit route, the way a row from before a check, or under a wider vocabulary, would sit there. The bundle is read from the stored cells, so no ledger row can reach a fetch.
  it.each([
    ['not json', 'not json'],
    ['a day no calendar holds', JSON.stringify(sampleSkeleton('00000000000b0001', undefined, '2026-99-99'))],
  ])('%s changes neither the bundle nor the ETag, and every pull still answers', async (_name, skeleton) => {
    const bad = await startPool();
    try {
      const deposited = async (id: string): Promise<string> => {
        const { token } = await bad.signIn('github', stubUser(id));
        await bad.post('/v1/covenant/accept', { version: 'v1' }, token);
        expect((await bad.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0')), token)).status).toBe(201);
        return token;
      };
      for (const id of ['5001', '5002', '5003', '5004']) await deposited(id);
      const token = await deposited('5005');
      const before = await bad.raw(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
      expect(before.status).toBe(200);

      await (await bad.db()).prepare('INSERT INTO accounts (id) VALUES (?)').bind('acct_bad_one').run();
      await (await bad.db()).prepare('INSERT INTO deposits (account, id, skeleton) VALUES (?, ?, ?)').bind('acct_bad_one', '00000000000b0001', skeleton).run();

      const after = await bad.raw(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
      expect(after.status).toBe(200);
      expect(after.json).toEqual(before.json);
      expect(after.headers.get('etag')).toBe(before.headers.get('etag'));
      const verified = await verifyBundle(after.json, bad.pinned(), 'claude-code', VERSION);
      if (!verified.ok) throw new Error(verified.reason);
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
    const { json } = await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token);
    return { payload: textOf(json, 'payload'), signature: textOf(json, 'signature') };
  };

  it('a tampered payload, a tampered signature, another key, and another harness version', async () => {
    const good = await signed();
    expect(fieldOf(await verifyBundle(good, pool.pinned(), 'claude-code', '2.1.314'), 'ok')).toBe(true);
    const tampered = good.payload.replace(/"clusters":\d+/, '"clusters":99');
    expect(tampered).not.toBe(good.payload);
    expect(await verifyBundle({ ...good, payload: tampered }, pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    const flipped = good.signature.startsWith('A') ? `B${good.signature.slice(1)}` : `A${good.signature.slice(1)}`;
    expect(await verifyBundle({ ...good, signature: flipped }, pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle(good, { k1: { ...pool.signingKey(), x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle(good, pool.pinned(), 'claude-code', '2.2.0')).toMatchObject({ ok: false, reason: containing('harness version') });
  });

  // Signed by a key the client pins, so the signature holds: only the vocabulary version, or the payload's shape, is wrong.
  it('a correctly signed bundle of another vocabulary version', async () => {
    const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    if (!('privateKey' in pair)) throw new Error('no key pair');
    const pinned = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    const key = { kty: String(pinned.kty), crv: String(pinned.crv), x: String(pinned.x) };
    const sign = async (vocabVersion: string, withStrata = true, harness: string | null = 'claude-code'): Promise<{ payload: string; signature: string }> => {
      const payload = JSON.stringify({ format: 1, ...(harness === null ? {} : { harness }), harnessVersion: '2.1.314', vocabVersion, floor: DEFAULT_FLOORS.public, asOf: { pool: 'p', day: '2026-11-04' }, cells: [], motifs: [], reads: [], ...(withStrata ? { strata: [] } : {}) });
      const signature = Buffer.from(await webcrypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(payload))).toString('base64');
      return { payload, signature };
    };
    expect(await verifyBundle(await sign(VOCAB_VERSION), { k1: key }, 'claude-code', '2.1.314')).toMatchObject({ ok: true });
    expect(await verifyBundle(await sign('9'), { k1: key }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('vocabulary version') });
    // Signed and of the right versions, but with no strata: the shape check refuses it, not the signature or a version.
    expect(await verifyBundle(await sign(VOCAB_VERSION, false), { k1: key }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('this version reads') });
    // The same bytes, validly signed, for a harness that was not asked for, and a payload that names no harness or one outside the schema's list.
    expect(await verifyBundle(await sign(VOCAB_VERSION, true, 'cursor'), { k1: key }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: 'this bundle is for harness cursor, not claude-code' });
    expect(await verifyBundle(await sign(VOCAB_VERSION, true, 'cursor'), { k1: key }, 'cursor', '2.1.314')).toMatchObject({ ok: true });
    expect(await verifyBundle(await sign(VOCAB_VERSION, true, null), { k1: key }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('this version reads') });
    expect(await verifyBundle(await sign(VOCAB_VERSION, true, 'acme'), { k1: key }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('this version reads') });
  });

  it('anything that is not a signed bundle', async () => {
    expect(await verifyBundle('nope', pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('not a signed bundle') });
    expect(await verifyBundle({ payload: 'x', signature: '%%%' }, pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
    expect(await verifyBundle({ payload: 'x', signature: 'AAAA' }, { k1: { kty: 'nope', crv: 'nope', x: 'nope' } }, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('signature') });
  });
});

describe('a bundle is one harness at one numbered bucket', () => {
  // A frame bucket starts with the harness, so two harnesses on one numbered bucket must not share a bundle.
  it('holds only the asked harness\'s cells when two harnesses deposit on the same version', async () => {
    const fresh = await startPool();
    try {
      let reader = '';
      for (const [harness, base, command] of [['claude-code', 7000, { program: 'git', sub: 'push' }], ['cursor', 7100, { program: 'ls', sub: null }]] as const) {
        for (let at = 0; at < 5; at += 1) {
          const id = String(base + at);
          const { token } = await fresh.signIn('github', stubUser(id));
          await fresh.post('/v1/covenant/accept', { version: 'v1' }, token);
          expect((await fresh.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), { languages: ['typescript'] }, '2026-11-01', harness, command), token)).status).toBe(201);
          reader = token;
        }
      }
      const bundleOf = async (harness: Harness): Promise<Bundle> => {
        const { status, json } = await fresh.get(`/bundle/${harness}/${VERSION}/${VOCAB_VERSION}`, reader);
        expect(status).toBe(200);
        const verified = await verifyBundle(json, fresh.pinned(), harness, VERSION);
        if (!verified.ok) throw new Error(verified.reason);
        return verified.bundle;
      };
      // The (name, platform, shell) cells name no harness, so they are in both bundles and the harness is read from the version cells.
      const harnessesOf = (bundle: Bundle): string[] => [...new Set(bundle.cells.filter((cell) => !cell.frameBucket.startsWith('env:')).map((cell) => cell.frameBucket.split('/')[0] ?? ''))];
      const claude = await bundleOf('claude-code');
      const cursor = await bundleOf('cursor');
      // The payload names its harness, signed with the rest.
      expect([claude.harness, cursor.harness]).toEqual(['claude-code', 'cursor']);
      expect(claude.cells.length).toBeGreaterThan(0);
      expect(cursor.cells.length).toBeGreaterThan(0);
      expect(harnessesOf(claude)).toEqual(['claude-code']);
      expect(harnessesOf(cursor)).toEqual(['cursor']);
      // Each bundle holds the version motifs of its own harness and no other's: git push is claude-code's, and ls is cursor's.
      const versioned = (bundle: Bundle): Set<string> => new Set(bundle.cells.filter((cell) => !cell.frameBucket.startsWith('env:')).map(({ motifId }) => motifId));
      const programsOf = (bundle: Bundle): string[] => [...new Set(bundle.motifs.filter(({ motifId }) => versioned(bundle).has(motifId)).flatMap(({ steps }) => steps.flatMap(({ identity }) => (identity !== null && 'program' in identity ? [identity.program] : []))))].sort();
      for (const bundle of [claude, cursor]) expect(bundle.motifs.map(({ motifId }) => motifId).sort()).toEqual([...new Set(bundle.cells.map(({ motifId }) => motifId))].sort());
      expect(programsOf(claude)).toEqual(['git']);
      expect(programsOf(cursor)).toEqual(['ls']);
      // The ETag names the harness: the claude-code ETag does not answer a cursor request with a 304.
      const path = `/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`;
      const cursorPath = `/bundle/cursor/${VERSION}/${VOCAB_VERSION}`;
      const claudeTag = (await fresh.raw(path, reader)).headers.get('etag');
      expect(claudeTag).not.toBeNull();
      expect((await fresh.raw(path, reader, { 'if-none-match': claudeTag ?? '' })).status).toBe(304);
      const crossed = await fresh.raw(cursorPath, reader, { 'if-none-match': claudeTag ?? '' });
      expect(crossed.status).toBe(200);
      expect(crossed.headers.get('etag')).not.toBe(claudeTag);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);
});

describe('a bundle for a harness with no version on record', () => {
  // Cursor, Gemini, and Grok Build record no version, and neither does a VS Code Copilot Chat session whose requests carry no `agent.extensionVersion`, so their sessions fill `<harness>/unknown/<model>` cells, which no numbered bundle holds. The route takes `unknown` for them.
  const deposits = async (fresh: TestPool, harness: Harness, version: string | null, base: number, count: number): Promise<string> => {
    let reader = '';
    for (let at = 0; at < count; at += 1) {
      const id = String(base + at);
      const { token } = await fresh.signIn('github', stubUser(id));
      await fresh.post('/v1/covenant/accept', { version: 'v1' }, token);
      expect((await fresh.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), { languages: ['typescript'] }, '2026-11-01', harness, { program: 'ls', sub: null }, version), token)).status).toBe(201);
      reader = token;
    }
    return reader;
  };
  const unknownBundle = async (fresh: TestPool, harness: Harness, token: string): Promise<Bundle> => {
    const { status, json } = await fresh.get(`/bundle/${harness}/unknown/${VOCAB_VERSION}`, token);
    expect(status).toBe(200);
    const verified = await verifyBundle(json, fresh.pinned(), harness, 'unknown');
    if (!verified.ok) throw new Error(verified.reason);
    return verified.bundle;
  };
  const ownCells = (bundle: Bundle): Bundle['cells'] => bundle.cells.filter((cell) => !cell.frameBucket.startsWith('env:'));

  it('withholds the unknown-version cells at four accounts and serves them at the fifth, and serves a versioned harness none of them', async () => {
    const fresh = await startPool();
    try {
      const four = await deposits(fresh, 'cursor', null, 8100, 4);
      const withheld = await unknownBundle(fresh, 'cursor', four);
      expect(withheld.harnessVersion).toBe('unknown');
      expect(withheld.cells).toEqual([]);
      expect(withheld.reads).toEqual([]);
      expect(withheld.motifs).toEqual([]);
      const five = await deposits(fresh, 'cursor', null, 8104, 1);
      const served = await unknownBundle(fresh, 'cursor', five);
      expect(ownCells(served).length).toBeGreaterThan(0);
      for (const cell of ownCells(served)) {
        expect(cell.frameBucket.startsWith('cursor/unknown/')).toBe(true);
        expect(cell.clusters).toBeGreaterThanOrEqual(5);
      }
      expect(served.reads.length).toBeGreaterThan(0);
      // The same pool answers a numbered request for that harness with the environment cells alone: the unknown cells are not under any number.
      const numbered = await fresh.get(`/bundle/cursor/${VERSION}/${VOCAB_VERSION}`, five);
      const numberedBundle = await verifyBundle(numbered.json, fresh.pinned(), 'cursor', VERSION);
      if (!numberedBundle.ok) throw new Error(numberedBundle.reason);
      expect(ownCells(numberedBundle.bundle)).toEqual([]);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  it('holds one harness\'s unknown-version cells apart from another\'s, and apart from a numbered version', async () => {
    const fresh = await startPool();
    try {
      await deposits(fresh, 'cursor', null, 8200, 5);
      await deposits(fresh, 'gemini', null, 8300, 5);
      const reader = await deposits(fresh, 'claude-code', VERSION, 8400, 5);
      const cursor = await unknownBundle(fresh, 'cursor', reader);
      const gemini = await unknownBundle(fresh, 'gemini', reader);
      expect(ownCells(cursor).every((cell) => cell.frameBucket.startsWith('cursor/unknown/'))).toBe(true);
      expect(ownCells(gemini).every((cell) => cell.frameBucket.startsWith('gemini/unknown/'))).toBe(true);
      expect(ownCells(cursor).length).toBeGreaterThan(0);
      expect(ownCells(gemini).length).toBeGreaterThan(0);
      // claude-code has a version on record, so its `unknown` bundle holds none of its numbered cells.
      expect(ownCells(await unknownBundle(fresh, 'claude-code', reader))).toEqual([]);
      // The tag names the version segment: a numbered tag does not answer an unknown request.
      const numberedTag = (await fresh.raw(`/bundle/cursor/${VERSION}/${VOCAB_VERSION}`, reader)).headers.get('etag');
      const crossed = await fresh.raw(`/bundle/cursor/unknown/${VOCAB_VERSION}`, reader, { 'if-none-match': numberedTag ?? '' });
      expect(crossed.status).toBe(200);
    } finally {
      await fresh.dispose();
    }
  }, 60_000);

  it('still refuses a word that is neither a number nor unknown', async () => {
    expect(await pool.get(`/bundle/cursor/Unknown/${VOCAB_VERSION}`, (await depositor('9001')))).toMatchObject({ status: 400, json: { error: 'unknown_harness_version' } });
    expect(await pool.get(`/bundle/cursor/none/${VOCAB_VERSION}`, (await depositor('9002')))).toMatchObject({ status: 400, json: { error: 'unknown_harness_version' } });
  });
});

describe('the ETag', () => {
  // A bundle is derived by the families it lists, so a client holding a tag from before a family was added must not be told its bundle is current.
  it('names the families a bundle derives, so a changed list is a changed tag', () => {
    const served = ['fit', 'cost'];
    expect(etagOf('claude-code', VERSION, 1, served, DEFAULT_FLOORS)).toBe(etagOf('claude-code', VERSION, 1, [...served], DEFAULT_FLOORS));
    expect(etagOf('claude-code', VERSION, 1, [...served, 'tool-day'], DEFAULT_FLOORS)).not.toBe(etagOf('claude-code', VERSION, 1, served, DEFAULT_FLOORS));
    expect(etagOf('claude-code', VERSION, 1, ['cost', 'fit'], DEFAULT_FLOORS)).not.toBe(etagOf('claude-code', VERSION, 1, served, DEFAULT_FLOORS));
  });
});

describe('the ETag of a fetch', () => {
  // `etagOf` is tested with its own lists above; here the route's own use of the served list is pinned, so a route that passed a constant would fail.
  it('is the tag of the served families at the generation of the pool', async () => {
    const token = await depositor('5401');
    const answer = await pool.raw(`/bundle/claude-code/${VERSION}/${VOCAB_VERSION}`, token);
    const db = await pool.db();
    const generation = Number(await db.prepare('SELECT generation FROM pool_generation WHERE id = 1').first('generation'));
    expect(generation).toBeGreaterThan(0);
    expect(answer.headers.get('etag')).toBe(etagOf('claude-code', VERSION, generation, [...SERVED.map(({ name }) => name), 'books'], floorsOf({ CLEAR_FLOOR: '5' }, () => undefined)));
  });
});

describe('fit by platform and shell', () => {
  // The cell is version-free, so it joins every version of a motif in a week: a total that is the sum of the version cells it sits beside. Served beside only some of them, its difference
  // from the served ones would be the others, so it is served only when no cell of its motif, week, and exposure is under the floor.
  const inFreshPool = async (run: (spread: TestPool) => Promise<void>, bindings: { [name: string]: string } = {}): Promise<void> => {
    const spread = await startPool(bindings);
    try {
      await run(spread);
    } finally {
      await spread.dispose();
    }
  };

  const depositFrom = async (spread: TestPool, id: string, harnessVersion: string, day = '2026-11-02', shell = 'bash'): Promise<string> => {
    const { token } = await spread.signIn('github', stubUser(id));
    await spread.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await spread.post('/v1/deposits', sampleSkeleton(id.padStart(16, '0'), undefined, day, 'claude-code', undefined, harnessVersion, shell), token)).status).toBe(201);
    return token;
  };

  const bundleFrom = async (spread: TestPool, token: string, version = VERSION): Promise<Bundle> => {
    const verified = await verifyBundle((await spread.get(`/bundle/claude-code/${version}/${VOCAB_VERSION}`, token)).json, spread.pinned(), 'claude-code', version);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.bundle;
  };

  const environmentReads = (bundle: Bundle) => bundle.reads.filter((read) => read.family === 'fit' && read.slice.platform !== undefined);
  const environmentCells = (bundle: Bundle) => bundle.cells.filter((cell) => cell.frameBucket.startsWith('env:'));

  it('serves a read per (name, platform, shell) at five accounts and none at four, with the clear floor at the public floor', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['5001', '5002', '5003']) await depositFrom(spread, id, VERSION);
      const four = await bundleFrom(spread, await depositFrom(spread, '5004', VERSION));
      expect(environmentReads(four)).toEqual([]);
      expect(environmentCells(four)).toEqual([]);

      const five = await bundleFrom(spread, await depositFrom(spread, '5005', VERSION));
      const reads = environmentReads(five);
      expect(reads.map((read) => read.slice)).toEqual([{ motif: 'shell.exec[program=git sub=push]', level: 'named', platform: 'linux', shell: 'bash' }]);
      const [read] = reads;
      expect(read?.clusters).toBe(5);
      expect(read?.value).toEqual({ failureRate: 0, failed: 0, ok: 10 });
      expect(read?.n).toBe(10);
      // The read's one input is the env cell the bundle holds.
      expect(read?.inputs).toHaveLength(1);
      expect(environmentCells(five).map((cell) => cell.frameBucket)).toEqual(['env:linux:bash']);
    }, { CLEAR_FLOOR: '5' });
  }, 60_000);

  it('serves the read of a clear (name, platform, shell) from the first account, at the default clear floor of 1', async () => {
    await inFreshPool(async (spread) => {
      const one = await bundleFrom(spread, await depositFrom(spread, '5401', VERSION));
      expect(environmentReads(one).map((read) => [read.slice, read.clusters])).toEqual([[{ motif: 'shell.exec[program=git sub=push]', level: 'named', platform: 'linux', shell: 'bash' }, 1]]);
      expect(environmentCells(one).map((cell) => cell.frameBucket)).toEqual(['env:linux:bash']);
      expect(one.floors).toMatchObject({ public: 5, clear: 1 });
    }, { CLEAR_FLOOR: '1' });
  }, 60_000);

  it('does not serve the version-free total beside a version cell under the floor, so no difference exposes it', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['5101', '5102', '5103', '5104']) await depositFrom(spread, id, VERSION);
      // Three accounts on another version bucket: under the floor in that bucket, though the version-free total is eight accounts.
      for (const id of ['5111', '5112', '5113']) await depositFrom(spread, id, '2.1.400');
      const token = await depositFrom(spread, '5105', VERSION);
      const bundle = await bundleFrom(spread, token);
      // The asked version has five accounts and is served; the total is not, because it would differ from the served cell by the other version's three.
      expect(bundle.cells.some((cell) => cell.frameBucket.startsWith('claude-code/'))).toBe(true);
      expect(environmentCells(bundle)).toEqual([]);
      expect(environmentReads(bundle)).toEqual([]);
      // The other version's own bundle serves neither its three accounts nor the total.
      const other = await bundleFrom(spread, token, '2.1.400');
      expect(other.cells).toEqual([]);

      // Two more accounts lift the other version to the floor: every cell of the motif clears it, and the total is served.
      for (const id of ['5114', '5115']) await depositFrom(spread, id, '2.1.400');
      const whole = await bundleFrom(spread, token);
      expect(environmentCells(whole).map((cell) => cell.sessions)).toEqual([10]);
      expect(environmentReads(whole)).toHaveLength(1);
      const [total] = environmentCells(whole);
      const partsOf = (bundle: Bundle): number => bundle.cells.filter((cell) => cell.motifId === total?.motifId && cell.grain === 'week' && cell.frameBucket.startsWith('claude-code/')).reduce((sum, cell) => sum + cell.sessions, 0);
      const versionSessions = partsOf(await bundleFrom(spread, token, '2.1.400'));
      const askedSessions = partsOf(whole);
      // With every version cell served, the difference of the total and the served cells is nothing: there is no sub-floor remainder to read.
      expect(10 - askedSessions - versionSessions).toBe(0);
    });
  }, 120_000);

  it('does not serve the version-free total beside an environment cell under the floor: five accounts on one shell and three on another, with the clear floor at the public floor', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['5301', '5302', '5303', '5304']) await depositFrom(spread, id, VERSION);
      const token = await depositFrom(spread, '5305', VERSION);
      // The version cell holds eight accounts and is served; the bash cell holds five, so served it would show the three on powershell as the version cell less it.
      for (const id of ['5311', '5312', '5313']) await depositFrom(spread, id, VERSION, '2026-11-02', 'powershell');
      const bundle = await bundleFrom(spread, token);
      expect(bundle.cells.some((cell) => cell.frameBucket.startsWith('claude-code/'))).toBe(true);
      expect(environmentCells(bundle)).toEqual([]);
      expect(environmentReads(bundle)).toEqual([]);

      // Two more on powershell lift it to the floor: both shells are served, and the difference is nothing.
      for (const id of ['5314', '5315']) await depositFrom(spread, id, VERSION, '2026-11-02', 'powershell');
      const whole = await bundleFrom(spread, token);
      expect(environmentCells(whole).map((cell) => [cell.frameBucket, cell.sessions])).toEqual([['env:linux:bash', 5], ['env:linux:powershell', 5]]);
    }, { CLEAR_FLOOR: '5' });
  }, 120_000);

  it('serves the total beside five accounts on one shell and three on another when every part is clear and at the clear floor of 1', async () => {
    await inFreshPool(async (spread) => {
      for (const id of ['5321', '5322', '5323', '5324']) await depositFrom(spread, id, VERSION);
      const token = await depositFrom(spread, '5325', VERSION);
      for (const id of ['5331', '5332', '5333']) await depositFrom(spread, id, VERSION, '2026-11-02', 'powershell');
      // Each part is a clear cell at or above the clear floor, so none is a sub-floor part the total could reveal.
      expect(environmentCells(await bundleFrom(spread, token)).map((cell) => [cell.frameBucket, cell.sessions])).toEqual([['env:linux:bash', 5], ['env:linux:powershell', 3]]);
    }, { CLEAR_FLOOR: '1' });
  }, 120_000);

  // The environment cells take no part in the bucket's own reads: a week that only another version holds is not a week of this bundle's pool, so it cannot move a read that says how long ago.
  it('leaves the asked version adoption unchanged when another version deposits in a later week, every part at the floor', async () => {
    await inFreshPool(async (spread) => {
      let token = '';
      for (const id of ['5201', '5202', '5203', '5204', '5205']) token = await depositFrom(spread, id, VERSION, '2026-10-12');
      const before = await bundleFrom(spread, token);
      // The value, not the read: its id and `asOf.pool` name the pool's cells, which did grow by the served environment cells.
      const adoptionOf = (bundle: Bundle) => bundle.reads.filter((read) => read.family === 'adoption').map((read) => read.value);
      expect(adoptionOf(before).length).toBeGreaterThan(0);
      expect(before.asOf.day).toBe('2026-10-12');

      // Three weeks on, five accounts on another version: its own cells and the version-free ones all clear the floor, so every one of them is served.
      for (const id of ['5211', '5212', '5213', '5214', '5215']) await depositFrom(spread, id, '2.1.400', '2026-11-02');
      const after = await bundleFrom(spread, token);
      expect(environmentCells(after).map((cell) => cell.day)).toContain('2026-11-02');
      expect(adoptionOf(after)).toEqual(adoptionOf(before));
      expect(after.asOf.day).toBe(before.asOf.day);
    });
  }, 120_000);
});

describe('the bundle names its signing key (S17)', () => {
  it('carries the key id the deploy sets, k1 until one is set, and refuses to serve under an id that is not an id', async () => {
    const token = (await pool.signIn('github', stubUser('7001'))).token;
    expect(fieldOf((await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token)).json, 'kid')).toBe('k1');
    const rotated = await startPool({ BUNDLE_KEY_ID: 'k2' });
    try {
      const rotatedToken = (await rotated.signIn('github', stubUser('7002'))).token;
      const answer = await rotated.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, rotatedToken);
      expect(fieldOf(answer.json, 'kid')).toBe('k2');
      expect(await verifyBundle(answer.json, { k2: rotated.signingKey() }, 'claude-code', '2.1.314')).toMatchObject({ ok: true });
      expect(await verifyBundle(answer.json, rotated.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('k2') });
    } finally {
      await rotated.dispose();
    }
    const typo = await startPool({ BUNDLE_KEY_ID: 'k 2!' });
    try {
      // Checked before the handle is read, so no approval is needed to see the refusal at login.
      expect(await typo.post('/v1/login/poll', { handle: 'any' })).toMatchObject({ status: 503, json: { error: 'not_configured' } });
      // The bundle route names the same missing setting: a person the pool knows (a row put in straight, since login is refused) gets a 503, never a bundle signed under no id.
      const db = await typo.db();
      await db.prepare("INSERT INTO accounts (id) VALUES ('acct_typo')").run();
      await db.prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct_typo', ?)").bind(createHash('sha256').update('typo-token').digest('hex'), Date.now() + 60_000).run();
      expect(await typo.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, 'typo-token')).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing('BUNDLE_KEY_ID') } });
    } finally {
      await typo.dispose();
    }
  });

  it('refuses a retired key id even when its key is pinned, and a key id nobody pinned, naming the id', async () => {
    const token = (await pool.signIn('github', stubUser('7004'))).token;
    const { json } = await pool.get(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, token);
    const bare = { payload: textOf(json, 'payload'), signature: textOf(json, 'signature') };
    expect(await verifyBundle(json, pool.pinned(), 'claude-code', '2.1.314', new Set(['k1']))).toMatchObject({ ok: false, reason: containing('k1') });
    expect(await verifyBundle(json, {}, 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('k1') });
    expect(await verifyBundle({ ...bare, kid: '__proto__' }, pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('__proto__') });
    expect(await verifyBundle({ ...bare, kid: 'x'.repeat(200) }, pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: false, reason: containing('unreadable') });
    // A bundle with no key id is read as k1, the id a pre-key-id sign-in pins under.
    expect(await verifyBundle(bare, pool.pinned(), 'claude-code', '2.1.314')).toMatchObject({ ok: true });
  });
});
