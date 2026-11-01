import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileAllow, parseAllowList, slugOf } from './allow.js';

describe('allowlist entries', () => {
  it('matches a folder by exact name or by path', () => {
    const allow = compileAllow(['-work-app', resolve('/work/other')]);
    expect(allow.allows('-work-app')).toBe(true);
    expect(allow.allows(slugOf(resolve('/work/other')))).toBe(true);
    expect(allow.allows('-work-app2')).toBe(false);
  });

  it('a trailing separator names the folder and everything under it, not a sibling that shares the prefix', () => {
    const base = slugOf(resolve('/work/team'));
    const allow = compileAllow([`${resolve('/work/team')}/`]);
    expect(allow.allows(base)).toBe(true);
    expect(allow.allows(`${base}-app`)).toBe(true);
    expect(allow.allows(`${base}x`)).toBe(false);
  });

  it('globs: * is any run, ? is one character, and separators match the slug dash', () => {
    const allow = compileAllow(['*-work-app-?', 'C:\\work\\x-*']);
    expect(allow.allows('-home-me-work-app-1')).toBe(true);
    expect(allow.allows('-home-me-work-app-12')).toBe(false);
    expect(allow.allows('C--work-x-anything')).toBe(true);
    expect(allow.allows('D--work-x-anything')).toBe(false);
  });

  it('reports the entries that matched no folder', () => {
    const allow = compileAllow(['-a', '-b*', 'gone']);
    expect(allow.unmatched(['-a', '-bee'])).toEqual(['gone']);
  });

  it('parses an allow list: one per line, blanks and comments skipped, CRLF tolerated', () => {
    expect(parseAllowList('# folders\r\n-a\r\n\r\n  -b*  \n#-c\n')).toEqual(['-a', '-b*']);
  });
});

describe('a leading ~', () => {
  it('expands to the home folder in a folder, a prefix, and a list file entry', () => {
    const home = homedir();
    expect(slugOf('~/work/app')).toBe(slugOf(join(home, 'work', 'app')));
    expect(compileAllow(['~/work/app']).allows(slugOf(join(home, 'work', 'app')))).toBe(true);
    const prefix = compileAllow(['~/work/']);
    expect(prefix.allows(slugOf(join(home, 'work')))).toBe(true);
    expect(prefix.allows(`${slugOf(join(home, 'work'))}-app`)).toBe(true);
    expect(compileAllow(['~']).allows(slugOf(home))).toBe(true);
    expect(compileAllow(['~other/x']).allows(slugOf(join(home, 'other', 'x')))).toBe(false);
  });
});
