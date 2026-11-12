import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aheadLines, isStale, loadEntries, staleLines } from './version-watch.mjs';

const DOC = fileURLToPath(new URL('../../../../../docs/harness-install.md', import.meta.url));

describe('versions.json and docs/harness-install.md', () => {
  it('the doc table lists every harness with the version and basis the versions file holds', () => {
    const section = readFileSync(DOC, 'utf8').split('## Versions last tested')[1]?.split('\n## ')[0] ?? '';
    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Harness') && !line.startsWith('|--'))
      .map((line) => line.split('|').map((cell) => cell.trim()).slice(1, 4));
    expect(rows).toEqual(loadEntries().map((entry) => [entry.name, entry.modeledOn ?? 'not stamped', entry.basis]));
  });
});

describe('isStale', () => {
  it('lets a patch release pass and fails a different minor or major under the default allowance', () => {
    expect(isStale('2.1.300', '2.1.999', 'minor')).toBe(false);
    expect(isStale('2.1.300', '2.2.0', 'minor')).toBe(true);
    expect(isStale('2.1.300', '3.1.300', 'minor')).toBe(true);
  });
  it('honors the major and patch allowances and ignores a version it cannot parse', () => {
    expect(isStale('2.1.300', '2.9.0', 'major')).toBe(false);
    expect(isStale('2.1.300', '3.0.0', 'major')).toBe(true);
    expect(isStale('2.1.300', '2.1.301', 'patch')).toBe(true);
    expect(isStale('2.1.300', '2.1.300', 'patch')).toBe(false);
    expect(isStale('2.1.300', 'next', 'minor')).toBe(false);
  });
  it('never calls a latest release below the fixture stale, whatever the allowance', () => {
    expect(isStale('2.2.5', '1.19.5', 'minor')).toBe(false);
    expect(isStale('2.2.5', '1.19.5', 'major')).toBe(false);
    expect(isStale('2.2.5', '2.2.4', 'patch')).toBe(false);
  });
});

describe('staleLines', () => {
  const entries = [
    { name: 'A', package: 'pa', modeledOn: '1.0.0', allowance: 'minor', basis: 'stamped' },
    { name: 'B', package: 'pb', modeledOn: '1.0.0', allowance: 'minor', basis: 'stamped' },
    { name: 'C', package: null, modeledOn: '1.0.0', allowance: 'minor', basis: 'stamped' },
    { name: 'D', package: 'pd', modeledOn: null, allowance: 'minor', basis: 'source' },
    { name: 'E', package: 'pe', modeledOn: '1.0.0', allowance: 'minor', basis: 'stamped' },
  ];
  it('names each stale harness with both versions and skips fresh, unpackaged, unstamped, and unavailable ones', () => {
    expect(staleLines(entries, { pa: '1.1.0', pb: '1.0.4', pd: '9.0.0' })).toEqual(['A: fixture 1.0.0, latest 1.1.0']);
  });
});

describe('aheadLines', () => {
  it('names a fixture stamped above every published release, and nothing else', () => {
    const entries = [
      { name: 'A', package: 'pa', modeledOn: '2.2.5', allowance: 'minor', basis: 'stamped' },
      { name: 'B', package: 'pb', modeledOn: '1.0.0', allowance: 'minor', basis: 'stamped' },
      { name: 'C', package: null, modeledOn: '2.0.0', allowance: 'minor', basis: 'stamped' },
    ];
    expect(aheadLines(entries, { pa: '1.19.5', pb: '1.0.0' })).toEqual([
      'A: fixture 2.2.5 is ahead of every release (latest 1.19.5); re-stamp versions.json',
    ]);
  });
});
