import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUNDLING_PROGRAMS,
  FRAMEWORKS,
  HARNESS_AGENT_TYPES,
  HARNESS_TOOLS,
  isVocabAhead,
  isVocabularyExpired,
  LANGUAGES,
  PUBLIC_FLAGS,
  PUBLIC_MCP_SERVERS,
  PUBLIC_MCP_TOOLS,
  PUBLIC_PACKAGES,
  PUBLIC_PROGRAMS,
  PUBLIC_SKILLS,
  PUBLIC_SUBCOMMANDS,
  READ_VOCAB_VERSIONS,
  REGISTRY_MAX_AGE_DAYS,
  VOCAB_SNAPSHOT_DATE,
  TOOL_INPUT_KEYS,
  VOCAB_VERSION,
} from './public-vocabulary.js';
import { vocabDir } from './vocab-load.js';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();
const tables = (map: ReadonlyMap<string, ReadonlySet<string>>): Array<[string, string[]]> => [...map].map(([key, set]): [string, string[]] => [key, sorted(set)]).sort(([a], [b]) => (a < b ? -1 : 1));

/** The curated lists in public-vocabulary.ts that the pool reads (the projection and `pool-wire.ts`), as one digest. */
const curatedDigest = (): string =>
  sha256(JSON.stringify([sorted(PUBLIC_PROGRAMS), sorted(BUNDLING_PROGRAMS), tables(PUBLIC_SUBCOMMANDS), sorted(PUBLIC_FLAGS), sorted(PUBLIC_MCP_SERVERS), tables(PUBLIC_MCP_TOOLS), tables(HARNESS_TOOLS), sorted(PUBLIC_SKILLS), tables(HARNESS_AGENT_TYPES), tables(TOOL_INPUT_KEYS), sorted(LANGUAGES), sorted(FRAMEWORKS), sorted(PUBLIC_PACKAGES)]));

interface Manifest {
  snapshotDate: string;
  files: { [file: string]: { bytes: number; sha256: string } };
}
const manifest = (): Manifest => {
  const parsed: unknown = JSON.parse(readFileSync(new URL('manifest.json', vocabDir()), 'utf8'));
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

const fileDigests = (): { [file: string]: string } => Object.fromEntries(Object.keys(manifest().files).map((file) => [file, sha256(readFileSync(new URL(file, vocabDir())))]));

/**
 * Each VOCAB_VERSION with the digest of every snapshot file's bytes and of the curated lists. Append an entry for a new version; never edit a
 * published one, except to repin `curated` in place when the only change is to a list the pool does not read (a list the pool reads is
 * a new version). A snapshot or curated list that changes without a new entry here fails the first test below.
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
    curated: 'faf8ee9dd0e9a363dd8ff4cc3b832c84fa746b7eb06c079475b7e0bbe2fe42c1',
  },
  '2': {
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
    curated: '293488e7e8be31f4a8a4faf93d30bf8e9840a0c8fc6dc896518f6b3fe561d66a',
  },
  '3': {
    files: {
      'crates.json': 'e83ea4b923d888783660e22d332f9add601513f47e0d8889bc4cf94d6db771f8',
      'go.json': 'e2e052cd9cde6340972fb15dc148aefac6568bf709d8357f57edededcaf74402',
      'harness.json': '85485b744d1450ec8661beeb87d906537bb9387790709c2010a8426eb91e567a',
      'homebrew.json': 'e465819d5d9e0c4af53849f1fcf658abb70fb786a6ecb09c4026a1cee984d91f',
      'maven.json': 'ed1ba57320b2f63f2057589876098301a8599c71968bd6615d500d5626b504d8',
      'models.json': '9be01e3c09e8075de4fd8eee0395c68a97bc85680df2b9bca1a63a0b4bc13618',
      'npm.json': 'f9cf2816adb208b271a50e8f5b73228c96f905681ec41406b3212d2deea8aefa',
      'programs.json': 'b7ca0803b05be14bf7a09ad2289e632e374254a2e559bff3924db53dfa9746ee',
      'pypi.json': 'e666a24f743afdc6708d353497751a875874c3aa6509c224c39a04894cec6460',
      'rubygems.json': '74aa914095289b1c27bfeb72e1367f27ad34c8086ed3b4aa34020b81d3b49bfa',
    },
    curated: '293488e7e8be31f4a8a4faf93d30bf8e9840a0c8fc6dc896518f6b3fe561d66a',
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
      const bytes = readFileSync(new URL(file, vocabDir()));
      expect({ file, bytes: bytes.length, sha256: sha256(bytes) }).toEqual({ file, ...held });
    }
  });
});

describe('the vocabularies the pool reads', () => {
  it('reads its own first, and an earlier one only while its curated lists equal the current ones, since the pool carries one set', () => {
    expect(READ_VOCAB_VERSIONS[0]).toBe(VOCAB_VERSION);
    expect(new Set(READ_VOCAB_VERSIONS).size).toBe(READ_VOCAB_VERSIONS.length);
    for (const version of READ_VOCAB_VERSIONS) expect({ version, curated: PINNED[version]?.curated }).toEqual({ version, curated: curatedDigest() });
  });

  it('takes only a later whole number as ahead of it', () => {
    const later = String(Number(VOCAB_VERSION) + 1);
    expect(READ_VOCAB_VERSIONS.map(isVocabAhead)).toEqual(READ_VOCAB_VERSIONS.map(() => false));
    expect([later, '1', 'vocab-9', '1e3', ''].map(isVocabAhead)).toEqual([true, false, false, false, false]);
  });
});

describe('registry_max_age', () => {
  const day = 86_400_000;
  const taken = Date.parse(`${VOCAB_SNAPSHOT_DATE}T00:00:00Z`);

  it('reads a snapshot as fresh through exactly registry_max_age and expired a millisecond after', () => {
    expect(isVocabularyExpired(new Date(taken))).toBe(false);
    // At most `registry_max_age` old (spec Section 1.3): exactly 30 days still builds a batch, 30 days and a millisecond does not, and the clock is not floored to a day.
    expect(isVocabularyExpired(new Date(taken + REGISTRY_MAX_AGE_DAYS * day))).toBe(false);
    expect(isVocabularyExpired(new Date(taken + REGISTRY_MAX_AGE_DAYS * day + 1))).toBe(true);
    expect(isVocabularyExpired(new Date(taken + REGISTRY_MAX_AGE_DAYS * day + day - 1))).toBe(true);
    expect(isVocabularyExpired(new Date(taken + (REGISTRY_MAX_AGE_DAYS + 1) * day))).toBe(true);
  });
});
