// The loader fails closed (vocab-load.ts line 3): a snapshot that is dated wrong, does not parse, or has the wrong shape is an error, never an empty list that
// would quietly project every name as `private`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VOCAB_SNAPSHOT_DATE, VOCAB_VERSION } from './public-vocabulary.js';
import { PACKAGE_FILES, readVocabulary, vocabulary } from './vocab-load.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const packageFile = (file: string): object => ({ ecosystem: file.replace('.json', ''), seedTop: 1, seed: [['a', ['1']]], resolved: ['b'] });

/** A small valid snapshot folder, with `overrides` written over its files as JSON (a string is written raw). */
const folder = (overrides: { [file: string]: unknown } = {}): URL => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-vocab-'));
  made.push(dir);
  const files: { [file: string]: unknown } = {
    'manifest.json': { snapshotDate: VOCAB_SNAPSHOT_DATE },
    ...Object.fromEntries(PACKAGE_FILES.map((file) => [file, packageFile(file)])),
    'programs.json': { programs: { ls: { subs: [], flags: ['-a'] } } },
    'harness.json': { harnesses: { 'claude-code': ['2.1.0'] } },
    'models.json': { ids: ['some-model'] },
    ...overrides,
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  return pathToFileURL(`${dir}/`);
};

describe('readVocabulary', () => {
  it('reads a well-formed folder', () => {
    const vocab = readVocabulary(folder());
    expect(vocab.version).toBe(VOCAB_VERSION);
    expect(vocab.snapshotDate).toBe(VOCAB_SNAPSHOT_DATE);
    expect([...vocab.packages.keys()].sort()).toEqual(PACKAGE_FILES.map((file) => file.replace('.json', '')).sort());
    expect(vocab.packages.get('npm')?.seed.get('a')).toEqual(new Set(['1']));
    expect(vocab.programs.get('ls')?.flags).toEqual(new Set(['-a']));
    expect(vocab.models).toEqual(new Set(['some-model']));
    expect(vocab.harnessVersions.get('claude-code')).toEqual(new Set(['2.1.0']));
  });

  it('refuses a manifest dated other than the date VOCAB_VERSION pins', () => {
    expect(() => readVocabulary(folder({ 'manifest.json': { snapshotDate: '2020-01-01' } }))).toThrow(/dated 2020-01-01 but VOCAB_VERSION .* pins/);
    expect(() => readVocabulary(folder({ 'manifest.json': {} }))).toThrow(/dated undefined/);
  });

  it('refuses a file that is not JSON, a missing file, and a file that is not an object', () => {
    expect(() => readVocabulary(folder({ 'npm.json': '{"ecosystem":' }))).toThrow(SyntaxError);
    expect(() => readVocabulary(folder({ 'models.json': '' }))).toThrow(SyntaxError);
    expect(() => readVocabulary(folder({ 'manifest.json': [] }))).toThrow('vocabulary manifest.json: expected an object');
    expect(() => readVocabulary(folder({ 'programs.json': { programs: [] } }))).toThrow('vocabulary programs: expected an object');
    expect(() => readVocabulary(pathToFileURL(`${tmpdir()}/oars-vocab-does-not-exist/`))).toThrow(/ENOENT/);
  });

  it('refuses a seed that is not a list, and a seed entry that is not [name, versions]', () => {
    expect(() => readVocabulary(folder({ 'npm.json': { ...packageFile('npm.json'), seed: {} } }))).toThrow('vocabulary npm.json: seed must be a list');
    expect(() => readVocabulary(folder({ 'npm.json': { ...packageFile('npm.json'), seed: ['a'] } }))).toThrow('a seed entry is [name, versions]');
    expect(() => readVocabulary(folder({ 'npm.json': { ...packageFile('npm.json'), seed: [[1, ['1']]] } }))).toThrow('a seed entry is [name, versions]');
    expect(() => readVocabulary(folder({ 'npm.json': { ...packageFile('npm.json'), seed: [['a', 'not a list']] } }))).toThrow('npm.json versions: expected a list of strings');
    expect(() => readVocabulary(folder({ 'npm.json': { ...packageFile('npm.json'), seed: [['a', [1]]] } }))).toThrow('npm.json versions: expected a list of strings');
  });

  it('refuses a resolved that is not a list of strings, and a package file without its ecosystem or seedTop', () => {
    expect(() => readVocabulary(folder({ 'pypi.json': { ...packageFile('pypi.json'), resolved: 'b' } }))).toThrow('pypi.json resolved: expected a list of strings');
    expect(() => readVocabulary(folder({ 'pypi.json': { ...packageFile('pypi.json'), resolved: ['b', 2] } }))).toThrow('pypi.json resolved: expected a list of strings');
    expect(() => readVocabulary(folder({ 'pypi.json': { ...packageFile('pypi.json'), ecosystem: undefined } }))).toThrow('ecosystem and seedTop are required');
    expect(() => readVocabulary(folder({ 'pypi.json': { ...packageFile('pypi.json'), seedTop: '1000' } }))).toThrow('ecosystem and seedTop are required');
  });

  it('refuses a program, model, or harness entry of the wrong shape', () => {
    expect(() => readVocabulary(folder({ 'programs.json': { programs: { ls: 'x' } } }))).toThrow('vocabulary programs.ls: expected an object');
    expect(() => readVocabulary(folder({ 'programs.json': { programs: { ls: { subs: 'x', flags: [] } } } }))).toThrow('programs.ls.subs: expected a list of strings');
    expect(() => readVocabulary(folder({ 'programs.json': { programs: { ls: { subs: [] } } } }))).toThrow('programs.ls.flags: expected a list of strings');
    expect(() => readVocabulary(folder({ 'models.json': { ids: 'm' } }))).toThrow('models.ids: expected a list of strings');
    expect(() => readVocabulary(folder({ 'harness.json': { harnesses: { 'claude-code': 7 } } }))).toThrow('harness.claude-code: expected a list of strings');
  });
});

describe('vocabulary', () => {
  it('reads the shipped folder once and returns the same object after', () => {
    const first = vocabulary();
    expect(first).toBe(vocabulary());
    expect(first.version).toBe(VOCAB_VERSION);
    expect(first.snapshotDate).toBe(VOCAB_SNAPSHOT_DATE);
    expect(first.programs.has('grep')).toBe(true);
  });

  it('reads each folder it is given once, and does not hand the first folder to a later one', () => {
    const other = folder({ 'models.json': { ids: ['only-in-the-other-folder'] } });
    const shipped = vocabulary();
    const given = vocabulary(other);
    expect(given).not.toBe(shipped);
    expect(given.models.has('only-in-the-other-folder')).toBe(true);
    expect(shipped.models.has('only-in-the-other-folder')).toBe(false);
    expect(vocabulary(other)).toBe(given);
    expect(vocabulary()).toBe(shipped);
  });
});
