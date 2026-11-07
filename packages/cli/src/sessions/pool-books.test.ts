// `oars sessions books` prints the set of four from the last fetched bundle: the pool's totals, read from the replica a fetch kept and checked again against the pinned key.
import { webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash } from './read.js';
import { booksLines, booksTotals, lastFetchedBundle } from './pool-books.js';
import { BUNDLE_FORMAT, VOCAB_VERSION, type Books, type Bundle } from './pool-wire.js';

const SERVER = 'https://pool.example.test';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-pool-books-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NONE = { state: 'no source yet', reason: 'no source feeds this yet' } as const;

const booksOf = (over: Partial<Books> = {}): Books => ({
  floor: 5,
  format: BUNDLE_FORMAT,
  vocabVersion: VOCAB_VERSION,
  asOf: { pool: 'p1', day: '2026-11-02' },
  served: { total: 12, byWeek: [{ week: '2026-11-02', cells: 12 }], byTuple: [] },
  backlog: 7,
  panelDay: '2026-11-07',
  panel: { state: 'value', value: 4 },
  demand: { comparisonReadOwners: { state: 'no source yet', reason: 'no comparison read exists to fetch yet' }, followOnReads: NONE },
  goal: { readYield: NONE, costPerServedCell: { state: 'no source yet', reason: 'no cost feed exists yet' }, yieldPerServedCell: NONE },
  ...over,
});

const bundleOf = (books: Books | undefined, harnessVersion = '2.1.314'): Bundle => ({ format: BUNDLE_FORMAT, harness: 'claude-code', harnessVersion, vocabVersion: VOCAB_VERSION, asOf: { pool: 'p1', day: '2026-11-02' }, cells: [], motifs: [], reads: [], strata: [], ...(books === undefined ? {} : { books }) });

const pair = async (): Promise<{ x: string; sign: (text: string) => Promise<string> }> => {
  const made = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in made)) throw new Error('no key pair');
  const { x } = await webcrypto.subtle.exportKey('jwk', made.publicKey);
  return { x: x ?? '', sign: async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', made.privateKey, new TextEncoder().encode(text))).toString('base64') };
};

/** Keeps a replica the way a fetch does, and records the sign-in that pinned the key. */
const keep = async (bundle: Bundle, signer: { x: string; sign: (text: string) => Promise<string> }, ageSeconds = 0): Promise<string> => {
  const folder = join(dir, 'pool-replica', contentHash(SERVER), bundle.harness);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${bundle.harnessVersion}.json`);
  const payload = JSON.stringify(bundle);
  writeFileSync(file, JSON.stringify({ payload, signature: await signer.sign(payload) }));
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, when, when);
  writeFileSync(join(dir, 'pool-accounts.json'), JSON.stringify([{ server: SERVER, account: 'a', token: 't', expiresAt: 1, signingKey: { kty: 'OKP', crv: 'Ed25519', x: signer.x } }]));
  return file;
};

describe('lastFetchedBundle', () => {
  it('reads the newest replica whose signature holds against the pinned key', async () => {
    const signer = await pair();
    await keep(bundleOf(booksOf({ backlog: 1 }), '2.1.300'), signer, 100);
    await keep(bundleOf(booksOf({ backlog: 2 })), signer);
    expect((await lastFetchedBundle(dir))?.books?.backlog).toBe(2);
  });

  it('is nothing when no fetch kept a bundle, or when the kept one no longer verifies', async () => {
    expect(await lastFetchedBundle(dir)).toBeUndefined();
    const signer = await pair();
    const file = await keep(bundleOf(booksOf()), signer);
    writeFileSync(file, JSON.stringify({ payload: JSON.stringify(bundleOf(booksOf({ backlog: 99 }))), signature: 'bad' }));
    expect(await lastFetchedBundle(dir)).toBeUndefined();
  });
});

describe('booksLines', () => {
  it('prints served cells, below floor, and as-of, then one line each for panel, demand, and goal metric', () => {
    expect(booksLines(bundleOf(booksOf()))).toEqual([
      'served cells 12, below floor 7, as of 2026-11-02',
      'panel: 4 accounts deposited in the last four weeks, as of 2026-11-07',
      'demand: comparison-read owners no source yet (no comparison read exists to fetch yet), follow-on reads no source yet (no source feeds this yet)',
      'goal metric: read yield no source yet (no source feeds this yet), cost per served cell no source yet (no cost feed exists yet), yield per served cell no source yet (no source feeds this yet)',
    ]);
  });

  it('says there is no pool bundle yet, and nothing else, when no bundle was fetched', () => {
    expect(booksLines(undefined)).toEqual(['no pool bundle yet']);
  });

  it('says so when the bundle predates the set of four', () => {
    expect(booksLines(bundleOf(undefined))).toEqual(['the last fetched bundle carries no pool books; run oars pool fetch again']);
  });

  it('never renders no source yet as 0, and keeps a measured zero as 0', () => {
    const lines = booksLines(bundleOf(booksOf({ panel: { state: 'value', value: 0 }, served: { total: 0, byWeek: [], byTuple: [] }, backlog: 0 }))).join('\n');
    expect(lines).toContain('served cells 0, below floor 0');
    expect(lines).toContain('panel: 0 accounts');
    expect(lines.replaceAll(/no source yet \([^)]*\)/g, '')).not.toMatch(/(?:owners|reads|yield|cell) 0/);
    expect(booksLines(bundleOf(booksOf({ panel: NONE }))).join('\n')).toContain('panel: no source yet (no source feeds this yet)');
  });

  it('says there is no known day for a pool with none', () => {
    expect(booksLines(bundleOf(booksOf({ asOf: { pool: 'p', day: null } })))[0]).toBe('served cells 12, below floor 7, as of no known day');
  });
});

describe('booksTotals', () => {
  it('is flat numbers with null for every field that has no source, and null when there are no books', () => {
    expect(booksTotals(bundleOf(booksOf()))).toEqual({ servedCells: 12, belowFloor: 7, panel: 4, comparisonReadOwners: null, followOnReads: null, readYield: null, costPerServedCell: null, yieldPerServedCell: null });
    expect(booksTotals(bundleOf(undefined))).toBeNull();
    expect(booksTotals(undefined)).toBeNull();
  });

  it('keeps a measured zero as 0', () => {
    expect(booksTotals(bundleOf(booksOf({ panel: { state: 'value', value: 0 } })))?.panel).toBe(0);
  });
});
