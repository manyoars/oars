// The life of a batch `oars pool hold pull` admitted (`pulled.json` in the outbox): it survives every prune and stale pass, is sent by the nightly loop, `--send`, and `oars pool outbox` at its own stamp, stays unsent and reported on a
// refusal, is rescanned against the current term file on each send pass, and leaves `pulled.json` once its hash is in `sent.log`. The pool is a stand-in that records each request.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nightlyPoolSend } from './pool-nightly.js';
import { sentLog } from './pool-sent.js';
import { harness } from '../test-support.js';
import { poolDeposit, poolOutbox, type Reply, type Sender } from './pool-command.js';
import type { Outgoing } from './pool-print.js';
import { REGISTER_FIXTURE } from './pool-fixture.js';
import { currentStamp, discardStale, outboxFolder, pulledAt, removeBatchesExcept, staleBatches, staleBatchesAnywhere, writeBatch } from './pool-outbox.js';
import { deposit, updatePoolChoices } from './store.js';
import { cleanup, NOW, settledClock, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const POOL = 'https://pool.test';
const LATER = Date.parse('2099-01-01T00:00:00Z');
const OLD = 'v1-0a0a0a0a';
const OLDER = 'v0-0b0b0b0b';
const KEY = '0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210';
const LOCAL_KEY = '1111111111111111';

const answer = (status: number, body: unknown = {}): Reply => ({ status, body, headers: new Headers() });
const OPEN = answer(200, { version: 'v1', accepted: true });

interface Pool {
  requests: Outgoing[];
  via: Sender;
}

/** Stands in for the pool: records each request and answers from `routes` (a list is spent in order, the last standing). */
const wire = (routes: { [route: string]: Reply | Reply[] }): Pool => {
  const requests: Outgoing[] = [];
  return {
    requests,
    via: (request) => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url.pathname}`];
      const reply = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
      return Promise.resolve(reply ?? answer(404, { error: 'not_found', message: 'No such route.' }));
    },
  };
};

const ACCEPTING = { 'GET /v1/covenant': OPEN, 'POST /v1/deposits': answer(201, { ok: true }) };

interface Scene {
  staged: Staged;
  deps: ReturnType<typeof harness>['deps'];
  outbox: string;
  termsFile: string;
  /** What `pulled.json` is made to say: each `admit` adds its id. */
  listed: { [id: string]: string };
}

const scene = async (terms = 'zorblax\n'): Promise<Scene> => {
  const staged = stage();
  const termsFile = join(staged.root, 'terms.txt');
  writeFileSync(termsFile, terms);
  const h = harness({ OARS_EXCLUSION_TERMS: termsFile, OARS_POOL_URL: POOL });
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
  await updatePoolChoices(staged.storeDir, (choices) => {
    choices.rawConsent = 'declined';
    choices.rawConsentVersion = null;
  });
  writeFileSync(join(staged.storeDir, 'pool-accounts.json'), JSON.stringify([{ server: POOL, account: 'acct_one', token: 'a-pool-token', expiresAt: LATER, signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'k' } }]));
  return { staged, deps: h.deps, outbox: outboxFolder(staged.storeDir, POOL), termsFile, listed: {} };
};

/** A session's batch as the pull admits it: the register's invented session under `id`, with `claimed`. */
const pulledBatch = (id: string, extra: object = {}): unknown => ({ ...structuredClone(REGISTER_FIXTURE), id, ...extra });

const pulledJson = (s: Scene): unknown => JSON.parse(readFileSync(join(s.outbox, 'pulled.json'), 'utf8'));
const listPulled = (s: Scene, entries: { [id: string]: string }): void => {
  mkdirSync(s.outbox, { recursive: true });
  writeFileSync(join(s.outbox, 'pulled.json'), `${JSON.stringify(entries)}\n`);
};

/** Files a batch the way `hold pull` does: under `stamp`, listed in `pulled.json` (unless `listed` is false). Answers its hash. */
const admit = async (s: Scene, id: string, stamp: string, extra: object = {}): Promise<string> => {
  const { hash } = await writeBatch(s.outbox, id, pulledBatch(id, extra), stamp);
  s.listed[id] = stamp;
  listPulled(s, s.listed);
  return hash;
};

const folderOf = (s: Scene, stamp: string): string[] => (existsSync(join(s.outbox, stamp)) ? readdirSync(join(s.outbox, stamp)).sort() : []);

describe('a pulled batch survives the prune', () => {
  it('is skipped by discardStale, staleBatches, and staleBatchesAnywhere at its own stamp, while a local stale batch in the same folder is still discarded', async () => {
    const s = await scene();
    const kept = await admit(s, KEY, OLD);
    await writeBatch(s.outbox, LOCAL_KEY, { id: LOCAL_KEY }, OLD);
    expect(await staleBatches(s.outbox)).toBe(1);
    expect(await staleBatchesAnywhere(s.staged.storeDir)).toBe(1);
    expect(await discardStale(s.outbox)).toBe(1);
    expect(folderOf(s, OLD)).toEqual([`${KEY}.${kept}.jsonl`]);
    expect(pulledJson(s)).toEqual({ [KEY]: OLD });
  });

  it('spares a key at the stamp it is listed under and no other: the same key filed under a second stamp is discarded', async () => {
    const s = await scene();
    await admit(s, KEY, OLD);
    await writeBatch(s.outbox, KEY, pulledBatch(KEY, { n: 2 }), OLDER);
    expect(await staleBatches(s.outbox)).toBe(1);
    expect(await discardStale(s.outbox)).toBe(1);
    expect(folderOf(s, OLDER)).toEqual([]);
    expect(folderOf(s, OLD)).toHaveLength(1);
  });

  it('removes a folder that holds nothing listed, as before, and leaves a pulled.json that is missing alone', async () => {
    const s = await scene();
    await writeBatch(s.outbox, LOCAL_KEY, { id: LOCAL_KEY }, OLD);
    expect(await discardStale(s.outbox)).toBe(1);
    expect(existsSync(join(s.outbox, OLD))).toBe(false);
    expect(existsSync(join(s.outbox, 'pulled.json'))).toBe(false);
  });

  it('keeps a current-stamp pulled batch through removeBatchesExcept and a poolDeposit pass, and removes a current-stamp batch nothing lists', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, currentStamp());
    await writeBatch(s.outbox, LOCAL_KEY, { id: LOCAL_KEY }, currentStamp());
    await poolDeposit(s.deps, { server: POOL, covenant: 'v1' });
    const names = folderOf(s, currentStamp());
    expect(names).toContain(`${KEY}.${hash}.jsonl`);
    expect(names.some((name) => name.startsWith(LOCAL_KEY))).toBe(false);
    expect(names.length).toBeGreaterThan(1);
    // The sessions the store built are not listed: the prune that keeps only listed keys leaves the pulled batch alone.
    await removeBatchesExcept(s.outbox, await pulledAt(s.outbox));
    expect(folderOf(s, currentStamp())).toEqual([`${KEY}.${hash}.jsonl`]);
  });

  it('survives a stamp change and a poolDeposit pass', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, OLD);
    await writeBatch(s.outbox, LOCAL_KEY, { id: LOCAL_KEY }, OLD);
    await poolDeposit(s.deps, { server: POOL, covenant: 'v1' });
    expect(folderOf(s, OLD)).toEqual([`${KEY}.${hash}.jsonl`]);
    expect(pulledJson(s)).toEqual({ [KEY]: OLD });
  });

  it('fails closed when pulled.json is not a list of ids and stamps: nothing is discarded', async () => {
    const s = await scene();
    await writeBatch(s.outbox, LOCAL_KEY, { id: LOCAL_KEY }, OLD);
    writeFileSync(join(s.outbox, 'pulled.json'), '[1, 2');
    await expect(discardStale(s.outbox)).rejects.toThrow(/not a list of ids and stamps/u);
    expect(folderOf(s, OLD)).toHaveLength(1);
  });
});


/** The deposits a pool stand-in took, as the bodies posted. */
const posted = (pool: Pool): string[] => pool.requests.filter((request) => request.method === 'POST' && request.url.pathname === '/v1/deposits').map((request) => String(request.body));

describe('the send reads every stamp pulled.json lists', () => {
  it('sends a pulled batch filed under an older stamp once, after a stamp change and a deposit pass, and drops its entry', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, OLD);
    const pool = wire(ACCEPTING);
    const first = await nightlyPoolSend(s.deps, pool.via);
    expect(first.outcome).toBe('sent');
    expect(posted(pool).filter((body) => body.includes(`"id":"${KEY}"`))).toHaveLength(1);
    expect([...(await sentLog(s.outbox)).keys()]).toContain(hash);
    expect(pulledJson(s)).toEqual({});
    const again = wire(ACCEPTING);
    await nightlyPoolSend(s.deps, again.via);
    expect(posted(again).filter((body) => body.includes(`"id":"${KEY}"`))).toEqual([]);
  });

  it('sends a pulled batch filed under the current stamp and drops its entry', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, currentStamp());
    const pool = wire(ACCEPTING);
    await nightlyPoolSend(s.deps, pool.via);
    expect(posted(pool).filter((body) => body.includes(`"id":"${KEY}"`))).toHaveLength(1);
    expect([...(await sentLog(s.outbox)).keys()]).toContain(hash);
    expect(pulledJson(s)).toEqual({});
  });

  it('never sends a local stale batch that shares the folder with a pulled one', async () => {
    const s = await scene();
    await admit(s, KEY, OLD);
    await writeBatch(s.outbox, LOCAL_KEY, pulledBatch(LOCAL_KEY), OLD);
    const pool = wire(ACCEPTING);
    await nightlyPoolSend(s.deps, pool.via);
    expect(posted(pool).filter((body) => body.includes(`"id":"${LOCAL_KEY}"`))).toEqual([]);
    expect(posted(pool).filter((body) => body.includes(`"id":"${KEY}"`))).toHaveLength(1);
  });

  it('prints a pulled batch under an older stamp in `oars pool outbox`, and sends it by `deposit --send` once it was shown', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, OLD);
    await writeBatch(s.outbox, LOCAL_KEY, pulledBatch(LOCAL_KEY), OLD);
    const printed = await poolOutbox(s.deps, { server: POOL });
    expect(printed.document).toMatchObject({ batches: [{ hash }], stale: 1 });
    const pool = wire(ACCEPTING);
    const sent = await poolDeposit(s.deps, { server: POOL, send: hash, via: pool.via });
    expect(sent.document).toMatchObject({ ok: true, sent: true });
    expect(posted(pool)).toHaveLength(1);
    expect(pulledJson(s)).toEqual({});
    const stale = await poolDeposit(s.deps, { server: POOL, send: hash, via: pool.via });
    expect(stale.document).toMatchObject({ sent: false });
  });

  it('refuses a hash that sits under an older stamp but is not listed', async () => {
    const s = await scene();
    const { hash } = await writeBatch(s.outbox, LOCAL_KEY, pulledBatch(LOCAL_KEY), OLD);
    await expect(poolDeposit(s.deps, { server: POOL, send: hash, via: wire(ACCEPTING).via })).rejects.toThrow(/not in the outbox|unknown|no batch/iu);
  });

  it('reads no path out of a stamp pulled.json lists that is not a stamp folder name', async () => {
    const s = await scene();
    listPulled(s, { [KEY]: '../../elsewhere' });
    const pool = wire(ACCEPTING);
    const night = await nightlyPoolSend(s.deps, pool.via);
    expect(night.outcome).toBe('sent');
    expect(posted(pool).filter((body) => body.includes(`"id":"${KEY}"`))).toEqual([]);
  });
});

/** A pool that refuses the deposit naming `refusedId` with `refusal`, and takes every other. */
const refusing = (refusedId: string, refusal: Reply): Pool => {
  const requests: Outgoing[] = [];
  return {
    requests,
    via: (request) => {
      requests.push(request);
      if (request.url.pathname === '/v1/covenant') return Promise.resolve(OPEN);
      return Promise.resolve(String(request.body).includes(`"id":"${refusedId}"`) ? refusal : answer(201, { ok: true }));
    },
  };
};

describe('a refused pulled batch is kept, unsent, and reported', () => {
  const REFUSALS: Array<[string, Reply]> = [
    ['closed_vocabulary', answer(422, { error: 'closed_vocabulary', message: 'pulled[0].name: not a public package', field: 'pulled[0].name' })],
    ['format', answer(422, { error: 'closed_vocabulary', message: 'format: the format 2 form is no longer read; send format 3', field: 'format' })],
  ];

  it.each(REFUSALS)('keeps the batch the pool refused for %s, sends the next one, deletes nothing, and says so in the night\'s note', async (_name, refusal) => {
    const s = await scene();
    const refused = await admit(s, KEY, OLD);
    const next = await admit(s, OTHER_KEY, OLD);
    const pool = refusing(KEY, refusal);
    const night = await nightlyPoolSend(s.deps, pool.via);
    expect(night).toMatchObject({ outcome: 'sent', refused: 1 });
    expect(JSON.parse(readFileSync(join(s.staged.storeDir, 'pool-nightly.json'), 'utf8'))).toMatchObject({ refused: 1 });
    expect(posted(pool).filter((body) => body.includes(`"id":"${OTHER_KEY}"`))).toHaveLength(1);
    const sent = [...(await sentLog(s.outbox)).keys()];
    expect(sent).toContain(next);
    expect(sent).not.toContain(refused);
    expect(folderOf(s, OLD)).toEqual([`${KEY}.${refused}.jsonl`, `${OTHER_KEY}.${next}.jsonl`]);
    expect(pulledJson(s)).toEqual({ [KEY]: OLD });
  });

  it('asks again on the next pass, and reports it again', async () => {
    const s = await scene();
    await admit(s, KEY, OLD);
    const refusal = REFUSALS[0]?.[1] ?? answer(500);
    expect(await nightlyPoolSend(s.deps, refusing(KEY, refusal).via)).toMatchObject({ refused: 1 });
    expect(await nightlyPoolSend(s.deps, refusing(KEY, refusal).via)).toMatchObject({ refused: 1 });
    expect(pulledJson(s)).toEqual({ [KEY]: OLD });
  });

  it('leaves the batch in place when `deposit --send` is refused, and marks nothing sent', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, OLD);
    await poolOutbox(s.deps, { server: POOL });
    const refusal = REFUSALS[0]?.[1] ?? answer(500);
    await expect(poolDeposit(s.deps, { server: POOL, send: hash, via: refusing(KEY, refusal).via })).rejects.toThrow(/not a public package/u);
    expect([...(await sentLog(s.outbox)).keys()]).not.toContain(hash);
    expect(pulledJson(s)).toEqual({ [KEY]: OLD });
    expect(folderOf(s, OLD)).toEqual([`${KEY}.${hash}.jsonl`]);
  });

  it('still ends the night for a refusal of a batch this machine built, and for any other refusal of a pulled one', async () => {
    const s = await scene();
    await admit(s, KEY, OLD);
    const server = answer(500, { error: 'internal', message: 'The pool failed.' });
    expect(await nightlyPoolSend(s.deps, refusing(KEY, server).via)).toMatchObject({ outcome: 'failed' });
    const local = await scene();
    const refusal = REFUSALS[0]?.[1] ?? answer(500);
    const night = await nightlyPoolSend(local.deps, (request) => Promise.resolve(request.url.pathname === '/v1/covenant' ? OPEN : refusal));
    expect(night).toMatchObject({ outcome: 'failed' });
    expect(night).not.toHaveProperty('refused');
  });
});

describe('each send pass rescans pulled batches against the current term file', () => {
  it('removes and reports a pulled batch that holds a term added since it was admitted, and sends the next one', async () => {
    const s = await scene();
    const held = await admit(s, KEY, OLD, { note: 'the zorblax project' });
    const next = await admit(s, OTHER_KEY, OLD);
    const pool = wire(ACCEPTING);
    const night = await nightlyPoolSend(s.deps, pool.via);
    expect(night).toMatchObject({ outcome: 'sent', removed: 1 });
    expect(posted(pool).filter((body) => body.includes(`"id":"${KEY}"`))).toEqual([]);
    expect(posted(pool).filter((body) => body.includes(`"id":"${OTHER_KEY}"`))).toHaveLength(1);
    expect(folderOf(s, OLD)).toEqual([`${OTHER_KEY}.${next}.jsonl`]);
    expect([...(await sentLog(s.outbox)).keys()]).not.toContain(held);
    expect(pulledJson(s)).toEqual({});
  });

  it('matches a term in a key as well as a value, in any case', async () => {
    const s = await scene();
    await admit(s, KEY, OLD, { Zorblax: 'x' });
    await admit(s, OTHER_KEY, OLD, { list: ['a', { deep: 'ZORBLAX' }] });
    const night = await nightlyPoolSend(s.deps, wire(ACCEPTING).via);
    expect(night).toMatchObject({ removed: 2 });
    expect(folderOf(s, OLD)).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', '\n'],
  ])('sends none and removes none while the term file is %s', async (_name, text) => {
    const s = await scene();
    const kept = await admit(s, KEY, OLD, { note: 'the zorblax project' });
    const clean = await admit(s, OTHER_KEY, currentStamp());
    if (text === undefined) rmSync(s.termsFile);
    else writeFileSync(s.termsFile, text);
    const pool = wire(ACCEPTING);
    const night = await nightlyPoolSend(s.deps, pool.via);
    expect(night.outcome).toBe('sent');
    expect(night).not.toHaveProperty('removed');
    expect(posted(pool)).toEqual([]);
    expect(folderOf(s, OLD)).toEqual([`${KEY}.${kept}.jsonl`]);
    expect(folderOf(s, currentStamp())).toContain(`${OTHER_KEY}.${clean}.jsonl`);
    expect(pulledJson(s)).toEqual({ [KEY]: OLD, [OTHER_KEY]: currentStamp() });
  });

  it('removes the batch `deposit --send` was asked for when it now holds a term, and sends nothing', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, OLD, { note: 'the zorblax project' });
    await poolOutbox(s.deps, { server: POOL });
    const pool = wire(ACCEPTING);
    await expect(poolDeposit(s.deps, { server: POOL, send: hash, via: pool.via })).rejects.toThrow(/exclusion list/u);
    expect(posted(pool)).toEqual([]);
    expect(folderOf(s, OLD)).toEqual([]);
    expect(pulledJson(s)).toEqual({});
  });

  it('sends nothing for a pulled batch by `deposit --send`, and removes nothing, while the term file is missing', async () => {
    const s = await scene();
    const hash = await admit(s, KEY, OLD, { note: 'the zorblax project' });
    await poolOutbox(s.deps, { server: POOL });
    rmSync(s.termsFile);
    const pool = wire(ACCEPTING);
    await expect(poolDeposit(s.deps, { server: POOL, send: hash, via: pool.via })).rejects.toThrow(/exclusion term file is missing/u);
    expect(posted(pool)).toEqual([]);
    expect(folderOf(s, OLD)).toEqual([`${KEY}.${hash}.jsonl`]);
    expect(pulledJson(s)).toEqual({ [KEY]: OLD });
  });
});
