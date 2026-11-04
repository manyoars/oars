// t776: a project folder that holds transcripts but is not on the allowlist is never read; `verify` says so instead of leaving it silent.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { sessionsBooks, sessionsVerify } from './command.js';
import { deposit, paths, skippedFolders } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-06-01T00:00:00Z', sessionId: 's1' });

describe('skippedFolders', () => {
  it('counts the folders holding transcripts that no allow entry names, and those transcripts', async () => {
    const staged = stage();
    addProject(staged, 'beta-app', 'one', [LINE]);
    addProject(staged, 'beta-app', 'two', [LINE]);
    addProject(staged, 'gamma-app', 'three', [LINE]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 2, transcripts: 3, names: ['beta-app', 'gamma-app'] });
  });

  it('counts a worktree folder of an allowed repository when only the repository folder is named', async () => {
    const staged = stage('-work-app');
    addProject(staged, '-work-app--claude-worktrees-t1-fix', 'one', [LINE]);
    await deposit(staged.runtime, { allow: ['-work-app'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toMatchObject({ folders: 1, names: ['-work-app--claude-worktrees-t1-fix'] });
  });

  it('does not count that worktree folder when the allow entry is a trailing-slash folder prefix', async () => {
    const staged = stage();
    const repository = resolve('/work/app');
    addProject(staged, `${slugOf(repository)}--claude-worktrees-t1-fix`, 'one', [LINE]);
    await deposit(staged.runtime, { allow: [`${repository}/`, 'proj'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 0, transcripts: 0, names: [] });
  });

  it('does not count that worktree folder when the allow entry is a glob', async () => {
    const staged = stage('-work-app');
    addProject(staged, '-work-app--claude-worktrees-t1-fix', 'one', [LINE]);
    await deposit(staged.runtime, { allow: ['-work-app*'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 0, transcripts: 0, names: [] });
  });

  it('ignores an empty folder and a folder whose only file is not a transcript', async () => {
    const staged = stage();
    mkdirSync(join(staged.projectsRoot, 'empty-app'));
    mkdirSync(join(staged.projectsRoot, 'notes-app'));
    writeFileSync(join(staged.projectsRoot, 'notes-app', 'readme.md'), 'x');
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 0, transcripts: 0, names: [] });
  });

  it('names a folder that holds only subagent transcripts, and counts no main transcript for it', async () => {
    const staged = stage();
    const subagents = join(staged.projectsRoot, 'delta-app', 'sess-one', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-a.jsonl'), `${LINE}\n`);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 1, transcripts: 0, names: ['delta-app'] });
  });

  it('names every folder holding transcripts when state.json is gone, since the saved allowlist is gone with it', async () => {
    const staged = stage();
    addProject(staged, 'beta-app', 'one', [LINE]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect(await skippedFolders(staged.runtime)).toMatchObject({ names: ['beta-app'] });
    rmSync(paths(staged.storeDir).state);
    expect(await skippedFolders(staged.runtime)).toMatchObject({ names: ['beta-app', 'proj'] });
  });

  it('is empty when the projects root is missing', async () => {
    const staged = stage();
    expect(await skippedFolders({ ...staged.runtime, projectsRoot: join(staged.root, 'absent') })).toEqual({ folders: 0, transcripts: 0, names: [] });
  });
});

describe('sessions verify and the folders it never reads', () => {
  const deps = (staged: ReturnType<typeof stage>) => ({ sessions: staged.runtime, install: undefined, now: () => NOW });

  it('reports the skipped folders in the text and the document, and does not fail --strict for them', async () => {
    const staged = stage();
    addProject(staged, 'beta-app', 'one', [LINE]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const verified = await sessionsVerify(deps(staged), { session: undefined });
    expect(verified.report.scope).toEqual({ folders: 1, transcripts: 1, names: ['beta-app'] });
    expect(verified.document).toMatchObject({ scope: { folders: 1, transcripts: 1, names: ['beta-app'] } });
    expect(verified.text).toMatch(/1 project folder holds 1 main transcript; it is never read: not on the allowlist\. Not captured: beta-app\./);
    expect(verified.failed).toEqual([]);
  });

  it('caps the names in the text and says how many more there are, and uses the plural', async () => {
    const staged = stage();
    for (let index = 0; index < 12; index += 1) addProject(staged, `extra-${String(index).padStart(2, '0')}`, 'one', [LINE]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const verified = await sessionsVerify(deps(staged), { session: undefined });
    expect(verified.report.scope.names).toHaveLength(12);
    expect(verified.text).toMatch(/12 project folders hold 12 main transcripts; they are never read/);
    expect(verified.text).toMatch(/extra-09, and 2 more\./);
  });

  it('prints the same scope line under books, and none when every folder is allowed', async () => {
    const staged = stage();
    addProject(staged, 'beta-app', 'one', [LINE]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const verified = await sessionsVerify(deps(staged), { session: undefined });
    const line = verified.text.split('\n').find((entry) => entry.includes('never read'));
    expect(line).toBeDefined();
    expect((await sessionsBooks(deps(staged), { by: 'class', sinceDays: undefined })).text.split('\n')).toContain(line);
    const allowed = stage();
    await deposit(allowed.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect((await sessionsBooks(deps(allowed), { by: 'class', sinceDays: undefined })).text).not.toMatch(/never read/);
  });

  it('prints no scope line when every folder is allowed', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const verified = await sessionsVerify(deps(staged), { session: undefined });
    expect(verified.report.scope).toEqual({ folders: 0, transcripts: 0, names: [] });
    expect(verified.text).not.toMatch(/never read/);
  });
});
