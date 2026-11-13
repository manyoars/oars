import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These cases spawn git and node processes; under load that takes past vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const script = fileURLToPath(new URL('./check-owner-name.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
// Built from parts so this test does not match the check it tests.
const NAME = 'Mat' + 't';

let root = '';

const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
const check = (target = root) => spawnSync('node', [script, target], { encoding: 'utf8' });
const track = (file: string, text: string) => {
  writeFileSync(join(root, file), text);
  git('add', file);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-owner-name-'));
  git('init', '-q');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-owner-name', () => {
  it('passes on a tree without the name', () => {
    track('a.md', 'Calls for the owner.\n');
    expect(check().status).toBe(0);
  });

  it('fails, naming path and line but not the text, on a tracked file that holds the name in any case', () => {
    track('a.md', `fine\n${NAME.toUpperCase()}'s call\n`);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a.md:2');
    expect(r.stderr).not.toContain(NAME.toUpperCase());
  });

  it('catches the handle and the mailbox domain', () => {
    track('b.txt', 'see mrd' + '5591\nswitchyard' + 'software.com\n');
    expect(check().stderr).toContain('b.txt:1');
  });

  it('ignores an untracked file and a longer word', () => {
    track('a.md', `${NAME}ress and ${NAME}e\n`);
    writeFileSync(join(root, 'untracked.md'), NAME);
    expect(check().status).toBe(0);
  });

  it('fails when the target is not a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'check-owner-name-plain-'));
    try {
      const r = check(plain);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('git grep failed');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('passes on this repository', () => {
    expect(check(repositoryRoot).status).toBe(0);
  });
});
