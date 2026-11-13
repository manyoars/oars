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
const LONG_NAME = 'Mat' + 'thew';

let root = '';

const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
// The handle and domain live in a local denylist, never in this tree; the test feeds neutral placeholders through the same variable.
const check = (target = root, denylist = join(tmpdir(), 'check-owner-name-absent-denylist.txt')) =>
  spawnSync('node', [script, target], { encoding: 'utf8', env: { ...process.env, OARS_PUBLIC_DENYLIST: denylist } });
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

  it('catches the longer given-name form', () => {
    track('c.txt', `x\n${LONG_NAME} said so\n`);
    expect(check().stderr).toContain('c.txt:2');
  });

  it('catches the handle and the mailbox domain listed in the denylist, each on its own line', () => {
    const list = join(root, '..', `check-owner-name-list-${String(process.pid)}.txt`);
    writeFileSync(list, 'zz-handle\nzz-domain.example\n');
    try {
      track('b.txt', 'see zz-handle\nwrite to ops@ZZ-Domain.example\nclean\n');
      const r = check(root, list);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('b.txt:1');
      expect(r.stderr).toContain('b.txt:2');
      expect(r.stderr).not.toContain('b.txt:3');
    } finally {
      rmSync(list, { force: true });
    }
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
