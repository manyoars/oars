// The life of a batch `oars pool hold pull` admitted (`pulled.json` in the outbox): it survives every prune and stale pass, is sent by the nightly loop, `--send`, and `oars pool outbox` at its own stamp, stays unsent and reported on a
// refusal, is rescanned against the current term file on each send pass, and leaves `pulled.json` once its hash is in `sent.log`. The pool is a stand-in that records each request.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness } from '../test-support.js';
import { poolDeposit } from './pool-command.js';
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
const LOCAL_KEY = '1111111111111111';

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

