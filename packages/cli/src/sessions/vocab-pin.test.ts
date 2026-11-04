import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUNDLING_PROGRAMS,
  HARNESS_AGENT_TYPES,
  HARNESS_TOOLS,
  isVocabularyExpired,
  PUBLIC_FLAGS,
  PUBLIC_MCP_SERVERS,
  PUBLIC_MCP_TOOLS,
  PUBLIC_PROGRAMS,
  PUBLIC_SKILLS,
  PUBLIC_SUBCOMMANDS,
  REGISTRY_MAX_AGE_DAYS,
  VOCAB_SNAPSHOT_DATE,
  TOOL_INPUT_KEYS,
  VOCAB_VERSION,
  vocabularyAgeDays,
} from './public-vocabulary.js';
import { VOCAB_DIR } from './vocab-load.js';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();
const tables = (map: ReadonlyMap<string, ReadonlySet<string>>): Array<[string, string[]]> => [...map].map(([key, set]): [string, string[]] => [key, sorted(set)]).sort(([a], [b]) => (a < b ? -1 : 1));

/** The curated lists in public-vocabulary.ts that the pool reads, as one digest. */
const curatedDigest = (): string =>
  sha256(JSON.stringify([sorted(PUBLIC_PROGRAMS), sorted(BUNDLING_PROGRAMS), tables(PUBLIC_SUBCOMMANDS), sorted(PUBLIC_FLAGS), sorted(PUBLIC_MCP_SERVERS), tables(PUBLIC_MCP_TOOLS), tables(HARNESS_TOOLS), sorted(PUBLIC_SKILLS), tables(HARNESS_AGENT_TYPES), tables(TOOL_INPUT_KEYS)]));

interface Manifest {
  snapshotDate: string;
  files: { [file: string]: { bytes: number; sha256: string } };
}
const manifest = (): Manifest => {
  const parsed: unknown = JSON.parse(readFileSync(new URL('manifest.json', VOCAB_DIR), 'utf8'));
  const snapshotDate: unknown = Reflect.get(Object(parsed), 'snapshotDate');
  const listed: unknown = Reflect.get(Object(parsed), 'files');
  if (typeof snapshotDate !== 'string' || typeof listed !== 'object' || listed === null) throw new Error('manifest.json is malformed');
  const files: Manifest['files'] = {};
  for (const [file, held] of Object.entries(listed)) {
    const bytes: unknown = Reflect.get(Object(held), 'bytes');
    const digest: unknown = Reflect.get(Object(held), 'sha256');
    if (typeof bytes !== 'number' || typeof digest !== 'string') throw new Error(`manifest.json: ${file} is malformed`);
    files[file] = { bytes, sha256: digest };
  }
  return { snapshotDate, files };
};

const fileDigests = (): { [file: string]: string } => Object.fromEntries(Object.keys(manifest().files).map((file) => [file, sha256(readFileSync(new URL(file, VOCAB_DIR)))]));

/**
 * Each VOCAB_VERSION with the digest of every snapshot file's bytes and of the curated lists. Append an entry for a new version; never edit a
 * published one. A snapshot or curated list that changes without a new entry here fails the first test below.
 */
const PINNED: { readonly [version: string]: { readonly files: { readonly [file: string]: string }; readonly curated: string } } = {
  '1': {
    files: {
      'crates.json': '32129283a2a14c492c0eba0f40b1e1686772d6d078f9a20b5aaa6d36670d1750',
      'go.json': '2b61bd86ff19aa5b44659726bc1f09ef2a20ebdb1bf8337dfac28c9eec6b4ec7',
      'harness.json': '05196ff492ca4a7327d81494c0f441f92ced5b778e66d2e16ce5a6b13cf6bd39',
      'homebrew.json': '66c9706a2d10d539e2a71e9419d7a9a7f0086b7b25b354988f7d2bcfa9695e76',
      'maven.json': '80cd922ac2ee65d9978a2fcf40372a0b3432e1003ba9f1d32fdba36e1059e8fe',
      'models.json': '51b5d362612dc8a298a887a3a20dd08c2275b91fcf4b6bba8a3545edcb568eb8',
      'npm.json': '61b931a5f4050d464e8cda0c27b90c5e51f293af973cde4e5b138999aa05c96a',
      'programs.json': '9d3baae2514586e601a51c230208d8fbf61a2d578d54d697d7614ab63158aaa0',
      'pypi.json': '4fd0e73a16ec5abcee1c970f7e28cc84af68aaceb0197b8007a8be690878f442',
      'rubygems.json': '0cfec417beb17efdbd60634fe7e6c9252bebc6be5bab086446431099d939be33',
    },
    curated: '6cddd7cfc0602f288ace775d63ca9ee81ead5bccd35e979e7632b8de81e8738b',
  },
};

describe('the pinned vocabulary', () => {
  it('matches the digests pinned for its VOCAB_VERSION, so a changed snapshot needs a version bump', () => {
    expect({ files: fileDigests(), curated: curatedDigest() }).toEqual(PINNED[VOCAB_VERSION]);
  });

  it('lists in vocab/manifest.json the size and digest of the bytes on disk, and the date VOCAB_VERSION pins', () => {
    const { snapshotDate, files } = manifest();
    expect(snapshotDate).toBe(VOCAB_SNAPSHOT_DATE);
    for (const [file, held] of Object.entries(files)) {
      const bytes = readFileSync(new URL(file, VOCAB_DIR));
      expect({ file, bytes: bytes.length, sha256: sha256(bytes) }).toEqual({ file, ...held });
    }
  });
});

describe('registry_max_age', () => {
  const day = 86_400_000;
  const taken = Date.parse(`${VOCAB_SNAPSHOT_DATE}T00:00:00Z`);

  it('reads a snapshot as fresh through exactly registry_max_age and expired a millisecond after', () => {
    expect(vocabularyAgeDays(new Date(taken - day))).toBe(0);
    expect(isVocabularyExpired(new Date(taken))).toBe(false);
    // At most `registry_max_age` old (spec Section 1.3): exactly 30 days still builds a batch, 30 days and a millisecond does not, and the clock is not floored to a day.
    expect(isVocabularyExpired(new Date(taken + REGISTRY_MAX_AGE_DAYS * day))).toBe(false);
    expect(isVocabularyExpired(new Date(taken + REGISTRY_MAX_AGE_DAYS * day + 1))).toBe(true);
    expect(isVocabularyExpired(new Date(taken + REGISTRY_MAX_AGE_DAYS * day + day - 1))).toBe(true);
    expect(isVocabularyExpired(new Date(taken + (REGISTRY_MAX_AGE_DAYS + 1) * day))).toBe(true);
  });
});
