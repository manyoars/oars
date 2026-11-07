// Shared by the books tests: a Books block, a bundle around it, and a signed replica kept the way a fetch keeps one, with the sign-in that pinned the key.
import { webcrypto } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './read.js';
import { BUNDLE_FORMAT, VOCAB_VERSION, type Books, type Bundle } from './pool-wire.js';

export const SERVER = 'https://pool.example.test';

export const NONE = { state: 'no source yet', reason: 'no source feeds this yet' } as const;

export const booksOf = (over: Partial<Books> = {}): Books => ({
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

export const bundleOf = (books: Books | undefined, harnessVersion = '2.1.314'): Bundle => ({ format: BUNDLE_FORMAT, harness: 'claude-code', harnessVersion, vocabVersion: VOCAB_VERSION, asOf: { pool: 'p1', day: '2026-11-02' }, cells: [], motifs: [], reads: [], strata: [], ...(books === undefined ? {} : { books }) });

export const pair = async (): Promise<{ x: string; sign: (text: string) => Promise<string> }> => {
  const made = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in made)) throw new Error('no key pair');
  const { x } = await webcrypto.subtle.exportKey('jwk', made.publicKey);
  return { x: x ?? '', sign: async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', made.privateKey, new TextEncoder().encode(text))).toString('base64') };
};

/** Keeps a replica the way a fetch does, and records the sign-in that pinned the key. */
export const keep = async (dir: string, bundle: Bundle, signer: { x: string; sign: (text: string) => Promise<string> }, ageSeconds = 0): Promise<string> => {
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
