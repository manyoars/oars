import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANDIDATES_FILE, readCandidates, recordCandidates, snapshotCandidates, type CandidateSnapshot } from './candidates.js';
import { hookRuntime, runHook } from './hooks.js';

let root: string;
let claudeDir: string;
const NOW = Date.UTC(2026, 10, 9, 12);

const write = (path: string, text = 'x'): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A plain checkout: a `.git` folder at `dir`. */
const repo = (dir: string): void => {
  mkdirSync(join(dir, '.git'), { recursive: true });
};

/** A linked worktree: a `.git` file at `dir` pointing into `main`'s `.git/worktrees/`, in the forward-slash form git writes on every platform. */
const worktree = (dir: string, main: string): void => {
  write(join(dir, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'x').replaceAll('\\', '/')}\n`);
};

const skill = (skillsDir: string, name: string): void => {
  write(join(skillsDir, name, 'SKILL.md'));
};

const snap = (cwd: string): Promise<Omit<CandidateSnapshot, 'v' | 'session' | 'at' | 'harness'>> => {
  mkdirSync(cwd, { recursive: true });
  return snapshotCandidates({ cwd, claudeDir });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oars-candidates-'));
  claudeDir = join(root, 'home', '.claude');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the instruction file positions', () => {
  it('counts a file in the working folder', async () => {
    repo(join(root, 'a'));
    write(join(root, 'a', 'sub', 'CLAUDE.md'));
    const shot = await snap(join(root, 'a', 'sub'));
    expect(shot.instructions).toEqual({ working: 1, parent: 0, above: 0, mainCheckout: 0, user: 0 });
    expect(shot.repoLevels).toBe(1);
    expect(shot.mainLevels).toBeNull();
  });

  it('counts a file in a parent inside the repo', async () => {
    repo(join(root, 'b'));
    write(join(root, 'b', 'CLAUDE.md'));
    write(join(root, 'b', 'sub', 'CLAUDE.md'));
    const shot = await snap(join(root, 'b', 'sub', 'deep'));
    expect(shot.instructions).toEqual({ working: 0, parent: 2, above: 0, mainCheckout: 0, user: 0 });
    expect(shot.repoLevels).toBe(2);
  });

  it('counts a file above the repo root', async () => {
    repo(join(root, 'c', 'repo'));
    write(join(root, 'c', 'CLAUDE.md'));
    const shot = await snap(join(root, 'c', 'repo'));
    expect(shot.instructions).toEqual({ working: 0, parent: 0, above: 1, mainCheckout: 0, user: 0 });
    expect(shot.repoLevels).toBe(0);
  });

  it('counts a user-level file', async () => {
    repo(join(root, 'e'));
    write(join(claudeDir, 'CLAUDE.md'));
    expect((await snap(join(root, 'e'))).instructions).toEqual({ working: 0, parent: 0, above: 0, mainCheckout: 0, user: 1 });
  });

  it('counts the user-level file once when the session runs inside the config folder', async () => {
    write(join(claudeDir, 'CLAUDE.md'));
    repo(claudeDir);
    expect((await snap(join(claudeDir, 'sub'))).instructions).toEqual({ working: 0, parent: 0, above: 0, mainCheckout: 0, user: 1 });
  });

  it('treats every parent as above when no repository holds the folder', async () => {
    write(join(root, 'f', 'CLAUDE.md'));
    const shot = await snap(join(root, 'f', 'sub'));
    expect(shot.instructions.above).toBe(1);
    expect(shot.repoLevels).toBeNull();
  });

  it('ignores a folder with the file name', async () => {
    repo(join(root, 'g'));
    mkdirSync(join(root, 'g', 'CLAUDE.md'));
    expect((await snap(join(root, 'g'))).instructions.working).toBe(0);
  });
});

describe('a linked worktree', () => {
  it('gives the span up to its main checkout its own position', async () => {
    const main = join(root, 'd', 'repo');
    repo(main);
    write(join(main, 'CLAUDE.md'));
    write(join(main, '.claude', 'worktrees', 'CLAUDE.md'));
    write(join(root, 'd', 'CLAUDE.md'));
    const x = join(main, '.claude', 'worktrees', 'x');
    worktree(x, main);
    write(join(x, 'CLAUDE.md'));
    const shot = await snap(x);
    expect(shot.instructions).toEqual({ working: 1, parent: 0, above: 1, mainCheckout: 2, user: 0 });
    expect(shot.repoLevels).toBe(0);
    expect(shot.mainLevels).toBe(3);
  });

  it('has no main-checkout span when it lives outside its main checkout', async () => {
    const x = join(root, 'side', 'x');
    worktree(x, join(root, 'main', 'repo'));
    write(join(root, 'side', 'CLAUDE.md'));
    const shot = await snap(x);
    expect(shot.instructions).toEqual({ working: 0, parent: 0, above: 1, mainCheckout: 0, user: 0 });
    expect(shot.mainLevels).toBeNull();
  });

  it('reads a submodule pointer as a plain repository root', async () => {
    const dir = join(root, 'parent', 'module');
    write(join(dir, '.git'), 'gitdir: ../.git/modules/module\n');
    const shot = await snap(dir);
    expect(shot.repoLevels).toBe(0);
    expect(shot.mainLevels).toBeNull();
  });

  it('reads a pointer under a folder not named .git as a plain repository root', async () => {
    const dir = join(root, 'odd', 'x');
    write(join(dir, '.git'), `gitdir: ${join(root, 'store', 'worktrees', 'x').replaceAll('\\', '/')}\n`);
    expect((await snap(dir)).mainLevels).toBeNull();
  });

  it('reads a .git file with no pointer as a plain repository root', async () => {
    const dir = join(root, 'odd2');
    write(join(dir, '.git'), 'not a pointer\n');
    const shot = await snap(dir);
    expect(shot.repoLevels).toBe(0);
    expect(shot.mainLevels).toBeNull();
  });
});

describe('the skill folders', () => {
  it('counts project skills up to the repo root, and user skills', async () => {
    repo(join(root, 's'));
    skill(join(root, 's', '.claude', 'skills'), 'one');
    skill(join(root, 's', 'sub', '.claude', 'skills'), 'two');
    skill(join(claudeDir, 'skills'), 'three');
    skill(join(claudeDir, 'skills'), 'four');
    // Above the repo root, so not this project's.
    skill(join(root, '.claude', 'skills'), 'outside');
    expect((await snap(join(root, 's', 'sub'))).skills).toEqual({ project: 2, user: 2 });
  });

  it('counts only folders that hold a skill file', async () => {
    repo(join(root, 's2'));
    mkdirSync(join(root, 's2', '.claude', 'skills', 'empty'), { recursive: true });
    write(join(root, 's2', '.claude', 'skills', 'loose.md'));
    expect((await snap(join(root, 's2'))).skills).toEqual({ project: 0, user: 0 });
  });

  it('reads only the working folder when no repository holds it', async () => {
    skill(join(root, 'n', '.claude', 'skills'), 'parent-skill');
    skill(join(root, 'n', 'sub', '.claude', 'skills'), 'own-skill');
    expect((await snap(join(root, 'n', 'sub'))).skills.project).toBe(1);
  });

  it('does not count the user folder as a project one when the repo root is the home folder', async () => {
    const home = dirname(claudeDir);
    repo(home);
    skill(join(claudeDir, 'skills'), 'only');
    expect((await snap(home)).skills).toEqual({ project: 0, user: 1 });
  });
});

describe('the configured hook events', () => {
  const hooks = (...events: string[]): string => JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command: 'c' }, { type: 'command', command: 'd' }] }]])) });

  it('counts commands per event across the three settings files', async () => {
    repo(join(root, 'h'));
    write(join(claudeDir, 'settings.json'), hooks('SessionStart', 'PreToolUse'));
    write(join(root, 'h', '.claude', 'settings.json'), hooks('SessionStart'));
    write(join(root, 'h', '.claude', 'settings.local.json'), hooks('Stop'));
    expect((await snap(join(root, 'h'))).hooks).toEqual({ SessionStart: 4, PreToolUse: 2, Stop: 2 });
  });

  it('counts an event the harness added later under its own name', async () => {
    repo(join(root, 'h1'));
    write(join(claudeDir, 'settings.json'), hooks('PostToolBatch', 'UserPromptExpansion', 'PreModelSwitch', 'PostModelSwitch', 'DirectoryAdded', 'MessageDisplay'));
    expect((await snap(join(root, 'h1'))).hooks).toEqual({ PostToolBatch: 2, UserPromptExpansion: 2, PreModelSwitch: 2, PostModelSwitch: 2, DirectoryAdded: 2, MessageDisplay: 2 });
  });

  it('folds an event name outside the closed list into other, so no free text is stored', async () => {
    repo(join(root, 'h2'));
    write(join(claudeDir, 'settings.json'), hooks('my-private-event'));
    const shot = await snap(join(root, 'h2'));
    expect(shot.hooks).toEqual({ other: 2 });
    expect(JSON.stringify(shot)).not.toContain('my-private-event');
  });

  it('ignores shapes that are not hook groups', async () => {
    repo(join(root, 'h3'));
    write(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: 'nope', SessionStart: ['nope', { hooks: 'nope' }] } }));
    expect((await snap(join(root, 'h3'))).hooks).toEqual({});
    write(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: 'nope' }));
    expect((await snap(join(root, 'h3'))).hooks).toEqual({});
    write(join(claudeDir, 'settings.json'), '[]');
    expect((await snap(join(root, 'h3'))).hooks).toEqual({});
  });

  it('does not count the user settings twice when the repo root is the home folder', async () => {
    const home = dirname(claudeDir);
    repo(home);
    write(join(claudeDir, 'settings.json'), hooks('Stop'));
    expect((await snap(home)).hooks).toEqual({ Stop: 2 });
  });
});

describe('recordCandidates', () => {
  const input = (cwd: string): { session: string; cwd: string; claudeDir: string; at: string } => ({ session: 'sess-1', cwd, claudeDir, at: new Date(NOW).toISOString() });

  it('appends one record of counts, with no path, file name, or skill name', async () => {
    const store = join(root, 'store');
    const cwd = join(root, 'private-project-name');
    repo(cwd);
    write(join(cwd, 'CLAUDE.md'), 'secret-instruction-text');
    skill(join(cwd, '.claude', 'skills'), 'private-skill-name');
    await recordCandidates(store, input(cwd));
    const text = readFileSync(join(store, CANDIDATES_FILE), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({
      v: 1,
      session: 'sess-1',
      at: new Date(NOW).toISOString(),
      harness: 'claude-code',
      instructions: { working: 1, parent: 0, above: 0, mainCheckout: 0, user: 0 },
      skills: { project: 1, user: 0 },
      hooks: {},
      repoLevels: 0,
      mainLevels: null,
    });
    for (const secret of ['private-project-name', 'secret-instruction-text', 'private-skill-name', 'CLAUDE.md', root.replaceAll('\\', '\\\\')]) expect(text).not.toContain(secret);
  });

  it('writes nothing and does not throw on a settings file it cannot parse', async () => {
    const store = join(root, 'store');
    const cwd = join(root, 'bad');
    repo(cwd);
    write(join(claudeDir, 'settings.json'), '{ not json');
    await expect(recordCandidates(store, input(cwd))).resolves.toBeUndefined();
    expect(existsSync(join(store, CANDIDATES_FILE))).toBe(false);
  });

  it('writes nothing and does not throw when the store cannot be created', async () => {
    const blocker = join(root, 'file-not-folder');
    write(blocker);
    const cwd = join(root, 'ok');
    repo(cwd);
    await expect(recordCandidates(join(blocker, 'store'), input(cwd))).resolves.toBeUndefined();
    expect(existsSync(join(blocker, 'store'))).toBe(false);
  });

  it('propagates an unexpected read error to the fail-open catch', async () => {
    // A NUL byte is refused by every file call with an error that is not "missing", so the snapshot stops and nothing is written.
    const store = join(root, 'store');
    await expect(snapshotCandidates({ cwd: join(root, 'a\0b'), claudeDir })).rejects.toThrow();
    await expect(recordCandidates(store, input(join(root, 'a\0b')))).resolves.toBeUndefined();
    expect(existsSync(join(store, CANDIDATES_FILE))).toBe(false);
  });
});

describe('readCandidates', () => {
  it('returns nothing when no file exists', async () => {
    expect((await readCandidates(join(root, 'nowhere'))).size).toBe(0);
  });

  it('keeps the first snapshot of each session and skips a line it cannot read', async () => {
    const store = join(root, 'store');
    const shot = (session: string, working: number): string =>
      JSON.stringify({ v: 1, session, at: 'a', harness: 'claude-code', instructions: { working, parent: 0, above: 0, mainCheckout: 0, user: 0 }, skills: { project: 0, user: 0 }, hooks: {}, repoLevels: 0, mainLevels: null });
    write(join(store, CANDIDATES_FILE), `${shot('one', 1)}\n{ torn\n"text"\n${JSON.stringify({ v: 2, session: 'later-format' })}\n${shot('one', 9)}\n${shot('two', 2)}\n`);
    const read = await readCandidates(store);
    expect([...read.keys()]).toEqual(['one', 'two']);
    expect(read.get('one')?.instructions.working).toBe(1);
  });

  it('skips a line of the current version that lacks the count groups, so a later join never reads a missing one', async () => {
    const store = join(root, 'store');
    const lacking = (missing: 'instructions' | 'skills' | 'hooks'): string => {
      const groups = { instructions: {}, skills: {}, hooks: {} };
      const kept = Object.fromEntries(Object.entries(groups).filter(([name]) => name !== missing));
      return JSON.stringify({ v: 1, session: missing, at: 'a', harness: 'claude-code', ...kept, repoLevels: 0, mainLevels: null });
    };
    write(join(store, CANDIDATES_FILE), `${JSON.stringify({ v: 1, session: 'bare' })}\n${lacking('instructions')}\n${lacking('skills')}\n${lacking('hooks')}\n${JSON.stringify({ v: 1, session: 'null-group', instructions: null, skills: {}, hooks: {} })}\n`);
    expect((await readCandidates(store)).size).toBe(0);
  });

  it('rethrows a read error that is not a missing file', async () => {
    const store = join(root, 'store');
    mkdirSync(join(store, CANDIDATES_FILE), { recursive: true });
    await expect(readCandidates(store)).rejects.toThrow();
  });
});

describe('the session-start hook', () => {
  it('records a snapshot in the store the runtime names, keyed by the session', async () => {
    const env = { APPDATA: join(root, 'appdata'), XDG_CONFIG_HOME: join(root, 'appdata') };
    const home = join(root, 'home');
    const runtime = hookRuntime('session-start', env, process.platform, home, { stdin: process.stdin, stdout: process.stdout });
    // The store must follow the redirected config folder before anything is written.
    expect(runtime.storeDir.startsWith(join(root, 'appdata'))).toBe(true);
    const cwd = join(root, 'p');
    repo(cwd);
    write(join(cwd, 'CLAUDE.md'));
    await runHook('session-start', JSON.stringify({ session_id: 'live', cwd }), runtime, () => NOW);
    const read = await readCandidates(runtime.storeDir);
    expect(read.get('live')?.instructions.working).toBe(1);
  });

  it('writes nothing when the input names no session or no folder', async () => {
    const env = { APPDATA: join(root, 'appdata'), XDG_CONFIG_HOME: join(root, 'appdata') };
    const runtime = hookRuntime('session-start', env, process.platform, join(root, 'home'), { stdin: process.stdin, stdout: process.stdout });
    expect(runtime.storeDir.startsWith(join(root, 'appdata'))).toBe(true);
    await runHook('session-start', JSON.stringify({ cwd: root }), runtime, () => NOW);
    await runHook('session-start', JSON.stringify({ session_id: 'no-folder' }), runtime, () => NOW);
    expect((await readCandidates(runtime.storeDir)).size).toBe(0);
  });
});
