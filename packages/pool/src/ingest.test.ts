import { describe, expect, it } from 'vitest';
import { deriveCells } from '../../cli/src/sessions/cells.js';
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { storeOf } from './derive.js';
import type { Bound, Env, PoolDb } from './http.js';
import { incrementsOf } from './ingest.js';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, type TestPool, textOf } from './test-pool.js';
import worker from './worker.js';

interface Held {
  key: string;
  sessions: number;
  clusters: number;
  ok: number;
  failed: number;
  tokens: number;
  durationMs: number;
}

const byKey = <T extends { key: string }>(held: T[]): T[] => held.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** What the landed derivation makes of the same batches: each account's cells, merged by key with counts added and `clusters` the accounts holding the key. */
const oracleOf = (byAccount: readonly (readonly SessionSkeleton[])[]): Held[] => {
  const merged = new Map<string, Held>();
  const accounts = new Map<string, Set<number>>();
  byAccount.forEach((skeletons, account) => {
    for (const cell of deriveCells(storeOf(skeletons)).cells) {
      const key = `${cell.motifId}/${cell.frameBucket}/${cell.day}/${cell.exposed ? '1' : '0'}`;
      const held = merged.get(key) ?? { key, sessions: 0, clusters: 0, ok: 0, failed: 0, tokens: 0, durationMs: 0 };
      merged.set(key, { key, sessions: held.sessions + cell.sessions, clusters: 0, ok: held.ok + cell.ok, failed: held.failed + cell.failed, tokens: held.tokens + cell.tokens, durationMs: held.durationMs + cell.durationMs });
      accounts.set(key, (accounts.get(key) ?? new Set<number>()).add(account));
    }
  });
  return byKey([...merged.values()].map((held) => ({ ...held, clusters: accounts.get(held.key)?.size ?? 0 })));
};

const strataOracle = (byAccount: readonly (readonly SessionSkeleton[])[]): { key: string; sessions: number; clusters: number }[] => {
  const tallies = new Map<string, { sessions: number; accounts: Set<number> }>();
  byAccount.forEach((skeletons, account) => {
    for (const { transcripts } of skeletons) {
      const frames = transcripts.flatMap(({ frame, prompts }) => [frame, ...prompts.map((prompt) => prompt.frame)]);
      const keys = [
        ...new Set(frames.flatMap(({ stack }) => stack.languages.map((value) => `language/${value}`))),
        ...new Set(frames.flatMap(({ stack }) => stack.frameworks.map((value) => `framework/${value}`))),
        ...new Set(frames.flatMap(({ stack }) => (stack.size === null ? [] : [`repoFiles/${stack.size}`]))),
      ];
      for (const key of keys) {
        const held = tallies.get(key) ?? { sessions: 0, accounts: new Set<number>() };
        held.sessions += 1;
        held.accounts.add(account);
        tallies.set(key, held);
      }
    }
  });
  return byKey([...tallies.entries()].map(([key, { sessions, accounts }]) => ({ key, sessions, clusters: accounts.size })));
};

const accountOn = async (target: TestPool, id: string): Promise<string> => {
  const { token } = await target.signIn('github', stubUser(id));
  await target.post('/v1/covenant/accept', { version: 'v1' }, token);
  return token;
};

const send = async (target: TestPool, token: string, skeleton: SessionSkeleton): Promise<void> => {
  expect((await target.post('/v1/deposits', skeleton, token)).status).toBe(201);
};

const inFreshPool = async (bindings: { [name: string]: string }, run: (target: TestPool) => Promise<void>): Promise<void> => {
  const target = await startPool(bindings);
  try {
    await run(target);
  } finally {
    await target.dispose();
  }
};

const total = async (target: TestPool, where = '1 = 1'): Promise<unknown> => (await target.db()).prepare(`SELECT COALESCE(SUM(sessions), 0) AS total FROM cells WHERE ${where}`).first('total');

describe('ingest writes cell increments to stored cells', () => {
  it('holds exactly the cells and strata the landed derivation computes over the same batches', async () => {
    await inFreshPool({}, async (target) => {
      const batches: SessionSkeleton[][] = [
        [sampleSkeleton('00000000000081a1', { languages: ['rust'], frameworks: ['astro'], size: 'xl' }, '2026-11-01'), sampleSkeleton('00000000000081a2', { languages: ['rust'] }, '2026-11-02')],
        [sampleSkeleton('00000000000081b1', { languages: ['rust', 'go'] }, '2026-11-01')],
        [sampleSkeleton('00000000000081c1', { languages: ['go'], size: 'xl' }, '2026-11-02'), sampleSkeleton('00000000000081c2', { languages: ['go'] }, '2026-11-02', 'cursor')],
      ];
      for (const [index, skeletons] of batches.entries()) {
        const token = await accountOn(target, `82${String(index)}`);
        for (const skeleton of skeletons) await send(target, token, skeleton);
      }
      const db = await target.db();
      const held = (await db.prepare('SELECT key, sessions, clusters, ok, failed, tokens, duration_ms AS durationMs FROM cells WHERE sessions > 0').all()).results;
      expect(byKey(held.map((row) => ({ key: textOf(row, 'key'), sessions: Number(fieldOf(row, 'sessions')), clusters: Number(fieldOf(row, 'clusters')), ok: Number(fieldOf(row, 'ok')), failed: Number(fieldOf(row, 'failed')), tokens: Number(fieldOf(row, 'tokens')), durationMs: Number(fieldOf(row, 'durationMs')) })))).toEqual(oracleOf(batches));
      expect(held.length).toBeGreaterThan(0);
      const strata = (await db.prepare('SELECT key, sessions, clusters FROM strata').all()).results;
      expect(byKey(strata.map((row) => ({ key: textOf(row, 'key'), sessions: Number(fieldOf(row, 'sessions')), clusters: Number(fieldOf(row, 'clusters')) })))).toEqual(strataOracle(batches));
      expect(strata.length).toBeGreaterThan(0);
      // Every cell's motif is stored once, so a read of the cells needs no skeleton.
      const motifs = new Set((await db.prepare('SELECT motif_id AS id FROM motifs').all()).results.map((row) => textOf(row, 'id')));
      const named = (await db.prepare('SELECT DISTINCT motif_id AS id FROM cells').all()).results.map((row) => textOf(row, 'id'));
      expect(named.every((id) => motifs.has(id))).toBe(true);
    });
  }, 60_000);

  it('replaces a session sent again instead of adding it a second time, and moves a session whose day changed', async () => {
    await inFreshPool({}, async (target) => {
      const token = await accountOn(target, '8301');
      const first = sampleSkeleton('0000000000008301', undefined, '2026-11-01');
      await send(target, token, first);
      const once = await total(target, "day = '2026-11-01'");
      expect(once).toBeGreaterThan(0);
      await send(target, token, first);
      expect(await total(target, "day = '2026-11-01'")).toBe(once);
      await send(target, token, sampleSkeleton('0000000000008301', undefined, '2026-11-02'));
      expect(await total(target, "day = '2026-11-01'")).toBe(0);
      expect(await total(target, "day = '2026-11-02'")).toBe(once);
      // The same id with another language moves the stratum too: the old one gives its session back and the new one takes it.
      const stratum = async (key: string): Promise<unknown> => (await target.db()).prepare('SELECT sessions FROM strata WHERE key = ?').bind(key).first('sessions');
      expect(await stratum('language/typescript')).toBe(1);
      await send(target, token, sampleSkeleton('0000000000008301', { languages: ['rust'] }, '2026-11-02'));
      expect(await stratum('language/typescript')).toBe(0);
      expect(await stratum('language/rust')).toBe(1);
    });
  }, 60_000);

  it('writes nothing for a deposit the pool refuses', async () => {
    await inFreshPool({ MAX_DEPOSITS_PER_ACCOUNT: '1' }, async (target) => {
      const token = await accountOn(target, '8401');
      await send(target, token, sampleSkeleton('0000000000008401', undefined, '2026-11-01'));
      const db = await target.db();
      const before = await total(target);
      const contributors = await db.prepare('SELECT COUNT(*) AS count FROM contributors').first('count');
      expect((await target.post('/v1/deposits', sampleSkeleton('0000000000008402', undefined, '2026-11-02'), token)).status).toBe(403);
      expect(await total(target)).toBe(before);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM contributors').first('count')).toBe(contributors);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM cells WHERE day = ?').bind('2026-11-02').first('count')).toBe(0);
    });
  }, 60_000);
});

describe('the held cell count', () => {
  const clustersOf = async (target: TestPool): Promise<number[]> => (await (await target.db()).prepare('SELECT clusters FROM cells WHERE sessions > 0 ORDER BY key').all()).results.map((row) => Number(fieldOf(row, 'clusters')));

  it('does not rise when a cluster returns, even on a later day, and rises when a new one arrives', async () => {
    await inFreshPool({}, async (target) => {
      const one = await accountOn(target, '8501');
      await send(target, one, sampleSkeleton('0000000000008501'));
      const first = await clustersOf(target);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((count) => count === 1)).toBe(true);

      // The same account again on the same UTC day, then with its records moved to an earlier day, so the next deposit is a later day for it.
      await send(target, one, sampleSkeleton('0000000000008502'));
      expect(await clustersOf(target)).toEqual(first);
      const db = await target.db();
      await db.prepare("UPDATE contributors SET day = '2000-01-01'").run();
      await send(target, one, sampleSkeleton('0000000000008503'));
      expect(await clustersOf(target)).toEqual(first);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM contributors WHERE kind = 'cell'").first('count')).toBe(first.length * 2);

      await send(target, await accountOn(target, '8502'), sampleSkeleton('0000000000008504'));
      expect((await clustersOf(target)).every((count) => count === 2)).toBe(true);
    });
  }, 60_000);

  it('counts a stratum the same way', async () => {
    await inFreshPool({}, async (target) => {
      const stack = { languages: ['swift'] };
      const one = await accountOn(target, '8601');
      for (const id of ['0000000000008601', '0000000000008602']) await send(target, one, sampleSkeleton(id, stack));
      const db = await target.db();
      const stratum = async (): Promise<unknown> => db.prepare("SELECT sessions, clusters FROM strata WHERE key = 'language/swift'").first();
      expect(await stratum()).toEqual({ sessions: 2, clusters: 1 });
      await send(target, await accountOn(target, '8602'), sampleSkeleton('0000000000008603', stack));
      expect(await stratum()).toEqual({ sessions: 3, clusters: 2 });
    });
  }, 60_000);
});

describe('two deposits of one session at once', () => {
  /** An env whose first read of a held batch waits for a second: both deposits then read the same earlier row, as two requests at the same moment do. */
  const gated = async (target: TestPool): Promise<Env> => {
    const { DB } = await target.miniflare.getBindings<{ DB: PoolDb }>();
    const opened = Promise.withResolvers<undefined>();
    let arrived = 0;
    return {
      COVENANT_VERSION: 'v1',
      DB: {
        batch: (statements) => DB.batch(statements),
        prepare: (sql) => ({
          bind: (...values): Bound => {
            const bound = DB.prepare(sql).bind(...values);
            if (!sql.startsWith('SELECT skeleton')) return bound;
            return {
              first: async () => {
                const row = await bound.first();
                arrived += 1;
                if (arrived === 2) opened.resolve(undefined);
                await opened.promise;
                return row;
              },
              all: () => bound.all(),
              run: () => bound.run(),
            };
          },
        }),
      },
    };
  };

  const deposit = async (env: Env, token: string, skeleton: SessionSkeleton): Promise<number> =>
    (await worker.fetch(new Request('https://pool.test/v1/deposits', { method: 'POST', body: JSON.stringify(skeleton), headers: { authorization: `Bearer ${token}` } }), env)).status;

  const sessionsOf = (skeleton: SessionSkeleton): number => [...incrementsOf(skeleton).cells.values()].reduce((sum, cell) => sum + cell.sessions, 0);

  it('takes one of two first sends and refuses the other, so the cells hold one batch', async () => {
    await inFreshPool({}, async (target) => {
      const token = await accountOn(target, '8701');
      const sent = sampleSkeleton('0000000000008701', undefined, '2026-11-01');
      const env = await gated(target);
      expect((await Promise.all([deposit(env, token, sent), deposit(env, token, sent)])).sort()).toEqual([201, 409]);
      expect(await total(target)).toBe(sessionsOf(sent));
      expect(await (await target.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(1);
    });
  }, 60_000);

  it('takes one of two resends and refuses the other, so the cells hold the replacing batch once', async () => {
    await inFreshPool({}, async (target) => {
      const token = await accountOn(target, '8702');
      await send(target, token, sampleSkeleton('0000000000008702', undefined, '2026-11-01'));
      const later = sampleSkeleton('0000000000008702', undefined, '2026-11-02');
      const env = await gated(target);
      expect((await Promise.all([deposit(env, token, later), deposit(env, token, later)])).sort()).toEqual([201, 409]);
      expect(await total(target, "day = '2026-11-01'")).toBe(0);
      expect(await total(target)).toBe(sessionsOf(later));
    });
  }, 60_000);

  it('names the refusal for the client to send again', async () => {
    await inFreshPool({}, async (target) => {
      const token = await accountOn(target, '8703');
      const sent = sampleSkeleton('0000000000008703');
      const env = await gated(target);
      const answers = await Promise.all([sent, sent].map(async (skeleton) => worker.fetch(new Request('https://pool.test/v1/deposits', { method: 'POST', body: JSON.stringify(skeleton), headers: { authorization: `Bearer ${token}` } }), env)));
      const refused = answers.find(({ status }) => status === 409);
      expect(await refused?.json()).toMatchObject({ error: 'deposit_conflict' });
    });
  }, 60_000);
});

// Two limits of the stored form, pinned and not solved: each needs the ledger or the cluster record rebuilt, which a later change owns. A test here changing means that change landed.
describe('what stored cells cannot take back', () => {
  it('counts a session a second time when its held row no longer parses and it is sent again', async () => {
    await inFreshPool({}, async (target) => {
      const token = await accountOn(target, '8801');
      const sent = sampleSkeleton('0000000000008801', undefined, '2026-11-01');
      await send(target, token, sent);
      const once = await total(target);
      expect(once).toBeGreaterThan(0);
      const db = await target.db();
      // Past the routes: valid JSON that is not a skeleton (the `parsed.ok` branch), then text that is not JSON (the `catch`). The increments the row made are still in the cells.
      await db.prepare("UPDATE deposits SET skeleton = '{}'").run();
      await send(target, token, sent);
      expect(await total(target)).toBe(Number(once) * 2);
      await db.prepare("UPDATE deposits SET skeleton = 'not json'").run();
      await send(target, token, sent);
      expect(await total(target)).toBe(Number(once) * 3);
    });
  }, 60_000);

  it('keeps an account counted in a cell it withdrew its session from', async () => {
    await inFreshPool({}, async (target) => {
      const db = await target.db();
      const tokens: string[] = [];
      for (const id of ['8811', '8812', '8813', '8814', '8815']) {
        const token = await accountOn(target, id);
        tokens.push(token);
        await send(target, token, sampleSkeleton(`${id.padStart(16, '0')}`, undefined, '2026-11-01'));
      }
      const held = async (): Promise<{ sessions: number; clusters: number }[]> =>
        (await db.prepare("SELECT sessions, clusters FROM cells WHERE day = '2026-11-01' AND sessions > 0").all()).results.map((row) => ({ sessions: Number(fieldOf(row, 'sessions')), clusters: Number(fieldOf(row, 'clusters')) }));
      expect((await held()).every(({ sessions, clusters }) => sessions === 5 && clusters === 5)).toBe(true);
      // The fifth account moves its session to another day: four accounts hold the cell now, and the count still says five.
      const fifth = tokens[4];
      if (fifth === undefined) throw new Error('no fifth account');
      await send(target, fifth, sampleSkeleton('0000000000008815', undefined, '2026-11-02'));
      const after = await held();
      expect(after.length).toBeGreaterThan(0);
      expect(after.every(({ sessions, clusters }) => sessions === 4 && clusters === 5)).toBe(true);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM contributors WHERE kind = 'cell' AND key LIKE '%/2026-11-01/%'").first('count')).toBe(after.length * 5);
    });
  }, 60_000);
});
