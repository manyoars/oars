// Loads the pinned vocabulary snapshots shipped in packages/cli/vocab/ (pool vocabulary spec Section 1.3). The only file here that reads the disk:
// public-vocabulary.ts stays free of the filesystem so the pool's Worker can bundle it, and projection.ts takes the loaded `Vocabulary` as an argument.
// A snapshot that does not parse is an error and never an empty list: an empty list would quietly project every name as `private`.

import { readFileSync } from 'node:fs';
import { VOCAB_SNAPSHOT_DATE, VOCAB_VERSION } from './public-vocabulary.js';

/** One package ecosystem: the seeded names with their published versions, and the names that resolve but sit outside `seed_top`. */
export interface PackageSnapshot {
  ecosystem: string;
  seedTop: number;
  seed: ReadonlyMap<string, ReadonlySet<string>>;
  resolved: ReadonlySet<string>;
}

export interface ProgramEntry {
  subs: ReadonlySet<string>;
  flags: ReadonlySet<string>;
}

export interface Vocabulary {
  version: string;
  snapshotDate: string;
  packages: ReadonlyMap<string, PackageSnapshot>;
  programs: ReadonlyMap<string, ProgramEntry>;
  models: ReadonlySet<string>;
  harnessVersions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * packages/cli/vocab/, from src/sessions/ in a test and from dist/sessions/ once built: the same depth. A function, not a constant: a bundle imported from a
 * `data:` URL (the pool's sample-pack command) has no file location, and building this URL at load time would throw before that caller could pass its own folder.
 */
export const vocabDir = (): URL => new URL('../../vocab/', import.meta.url);

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const recordAt = (value: unknown, where: string): { [key: string]: unknown } => {
  if (!isRecord(value)) throw new Error(`vocabulary ${where}: expected an object`);
  return value;
};

const stringsAt = (value: unknown, where: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`vocabulary ${where}: expected a list of strings`);
  return value.filter((item): item is string => typeof item === 'string');
};

const readJson = (dir: URL, file: string): { [key: string]: unknown } => recordAt(JSON.parse(readFileSync(new URL(file, dir), 'utf8')), file);

const packageSnapshot = (dir: URL, file: string): PackageSnapshot => {
  const json = readJson(dir, file);
  const seed = json['seed'];
  if (!Array.isArray(seed)) throw new Error(`vocabulary ${file}: seed must be a list`);
  const entries = seed.map((pair): [string, ReadonlySet<string>] => {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') throw new Error(`vocabulary ${file}: a seed entry is [name, versions]`);
    return [pair[0], new Set(stringsAt(pair[1], `${file} versions`))];
  });
  const ecosystem = json['ecosystem'];
  const seedTop = json['seedTop'];
  if (typeof ecosystem !== 'string' || typeof seedTop !== 'number') throw new Error(`vocabulary ${file}: ecosystem and seedTop are required`);
  return { ecosystem, seedTop, seed: new Map(entries), resolved: new Set(stringsAt(json['resolved'], `${file} resolved`)) };
};

export const PACKAGE_FILES = ['npm.json', 'pypi.json', 'crates.json', 'rubygems.json', 'homebrew.json', 'go.json', 'maven.json'] as const;

/** Reads and checks every snapshot under `dir` (default: the shipped folder). */
export const readVocabulary = (dir: URL = vocabDir()): Vocabulary => {
  const manifest = readJson(dir, 'manifest.json');
  const snapshotDate = manifest['snapshotDate'];
  if (snapshotDate !== VOCAB_SNAPSHOT_DATE) {
    throw new Error(`vocabulary snapshots are dated ${String(snapshotDate)} but VOCAB_VERSION ${VOCAB_VERSION} pins ${VOCAB_SNAPSHOT_DATE}: bump both together`);
  }
  const packages = new Map(PACKAGE_FILES.map((file) => packageSnapshot(dir, file)).map((snapshot) => [snapshot.ecosystem, snapshot]));
  const programs = new Map(
    Object.entries(recordAt(readJson(dir, 'programs.json')['programs'], 'programs')).map(([name, entry]): [string, ProgramEntry] => {
      const held = recordAt(entry, `programs.${name}`);
      return [name, { subs: new Set(stringsAt(held['subs'], `programs.${name}.subs`)), flags: new Set(stringsAt(held['flags'], `programs.${name}.flags`)) }];
    }),
  );
  const harnesses = recordAt(readJson(dir, 'harness.json')['harnesses'], 'harnesses');
  return {
    version: VOCAB_VERSION,
    snapshotDate,
    packages,
    programs,
    models: new Set(stringsAt(readJson(dir, 'models.json')['ids'], 'models.ids')),
    harnessVersions: new Map(Object.entries(harnesses).map(([harness, versions]): [string, ReadonlySet<string>] => [harness, new Set(stringsAt(versions, `harness.${harness}`))])),
  };
};

const loaded = new Map<string, Vocabulary>();
/** The vocabulary of a folder (the shipped one by default), read once per folder on first use: reading 6 MB of JSON is not free, and most commands never project. `dir` is for a caller that cannot locate the folder itself. */
export const vocabulary = (dir: URL = vocabDir()): Vocabulary => {
  const held = loaded.get(dir.href);
  if (held !== undefined) return held;
  const read = readVocabulary(dir);
  loaded.set(dir.href, read);
  return read;
};
