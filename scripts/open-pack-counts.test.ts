import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countPack } from '../recipes/open-pack-counts/open-pack-counts.mjs';

const script = fileURLToPath(new URL('../recipes/open-pack-counts/open-pack-counts.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../recipes/open-pack-counts/fixture', import.meta.url));

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const TABLES = [
  'Pack: fixture (built 2026-01-01T00:00:00.000Z, key fixture)',
  'Sessions read: 3 of 4 manifest rows. Skipped: 5.',
  '  skipped: manifest.jsonl line 3: not valid JSON',
  '  skipped: manifest.jsonl line 4: harness version is not text',
  '  skipped: sessions/ccc/skeleton.json: tool 1 of transcript 0 is not an object',
  '  skipped: sessions/ccc/skeleton.json: transcript 1 has no tools list',
  '  skipped: sessions/ddd/skeleton.json: not valid JSON',
  '',
  'Failed calls per error code',
  '  1      2',
  '  other  1',
  '  total  3',
  '',
  'Failed calls by what followed',
  '  edit followed     1',
  '  no edit followed  2',
  '  not recorded      0',
  '',
  'Sessions per harness version',
  '  2.1.1  2',
  '  2.1.2  2',
  '  2.1.3  1',
  '',
];

const EXPECTED = {
  pack: { name: 'fixture', built: '2026-01-01T00:00:00.000Z', keyId: 'fixture' },
  manifestRows: 4,
  sessionsRead: 3,
  skipped: [
    { file: 'manifest.jsonl', line: 3, reason: 'not valid JSON' },
    { file: 'manifest.jsonl', line: 4, reason: 'harness version is not text' },
    { file: 'sessions/ccc/skeleton.json', reason: 'tool 1 of transcript 0 is not an object' },
    { file: 'sessions/ccc/skeleton.json', reason: 'transcript 1 has no tools list' },
    { file: 'sessions/ddd/skeleton.json', reason: 'not valid JSON' },
  ],
  failedCallsPerErrorCode: { '1': 2, other: 1 },
  failedCallsByWhatFollowed: { 'edit followed': 1, 'no edit followed': 2, 'not recorded': 0 },
  sessionsPerHarnessVersion: { '2.1.1': 2, '2.1.2': 2, '2.1.3': 1 },
};

describe('open-pack-counts recipe', () => {
  it('prints the failed-call table and the version table for the fixture pack, with the zero row and both skips', () => {
    const r = run(fixture);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual([...TABLES, '']);
  });

  it('prints the same numbers as JSON with --json', () => {
    const r = run(fixture, '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(EXPECTED);
  });

  it('returns the same object from countPack, which also pulls the recipe into the type check', () => {
    expect(countPack(fixture, undefined)).toEqual(EXPECTED);
  });


  it('answers a changed question with --by model: the same failed calls split by the model of the prompt', () => {
    const r = run(fixture, '--by', 'model');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Failed calls per model\n  model-a  2\n  model-b  1\n  total    3\n');
    expect(r.stdout).not.toBe(run(fixture).stdout);
  });

  it('splits by prompt class with --by class and carries the split in JSON', () => {
    const r = run(fixture, '--by', 'class');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      ['Failed calls per prompt class', '  edit-verify  2', '  research     1', '  total        3', ''].join('\n'),
    );
    expect(JSON.parse(run(fixture, '--json', '--by', 'model').stdout)).toMatchObject({
      failedCallsPerModel: { 'model-a': 2, 'model-b': 1 },
    });
  });

  it('exits 1 and names the path when a file the schema requires is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-pack-counts-'));
    try {
      cpSync(fixture, dir, { recursive: true });
      rmSync(join(dir, 'sessions', 'bbb', 'skeleton.json'));
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(join(dir, 'sessions', 'bbb', 'skeleton.json'));
      expect(r.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names manifest.jsonl when the pack has none', () => {
    const r = run(join(fixture, 'sessions'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('manifest.jsonl');
  });

  it('exits 2 with a usage line when given no folder or an unknown --by', () => {
    expect(run().status).toBe(2);
    expect(run(fixture, '--by', 'nothing').status).toBe(2);
  });
});
