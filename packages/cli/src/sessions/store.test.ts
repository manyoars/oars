import { appendFileSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError, ExitCode } from '../errors.js';
import { deposit, derive, loadStore, paths, readCalls, readSkeletons, slugOf } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

describe('deposit', () => {
  it('refuses to run without an --allow', async () => {
    const staged = stage();
    const error: unknown = await deposit(staged.runtime, options([])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect(error instanceof CliError && error.exitCode).toBe(ExitCode.USAGE);
    expect(() => readFileSync(paths(staged.storeDir).observations)).toThrow();
  });

  it('reads only allowed folders, by name or by path, and counts the skipped ones', async () => {
    const staged = stage('-work-app');
    addProject(staged, '-work-other', 'x', ['{"type":"user"}']);
    const byName = await deposit(staged.runtime, options(['-work-app']));
    expect(byName).toMatchObject({ sessions: 4, skippedFolders: 1, folders: ['-work-app'], missing: [], badLines: 1 });
    expect(slugOf('/work/app')).toBe('-work-app');
    const staged2 = stage('-work-app');
    const byPath = await deposit(staged2.runtime, options(['/work/app', '/nowhere']));
    expect(byPath).toMatchObject({ sessions: 4, folders: ['-work-app'], missing: ['/nowhere'] });
  });

  it('is idempotent: a second run skips unchanged files and appends nothing', async () => {
    const staged = stage();
    const first = await deposit(staged.runtime, options(['proj']));
    const size = statSync(paths(staged.storeDir).observations).size;
    const second = await deposit(staged.runtime, options(['proj']));
    expect(first.sessions).toBe(4);
    expect(first.observations).toBe(4 + 7 + 6);
    expect(second).toMatchObject({ sessions: 0, unchanged: 4, observations: 0 });
    expect(statSync(paths(staged.storeDir).observations).size).toBe(size);
  });

  it('re-deposits a changed file under a higher rev and a reader keeps only the latest', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const before = await loadStore(staged.storeDir);
    const file = join(staged.projectsRoot, 'proj', 'tldr.jsonl');
    appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'one more prompt' } })}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const again = await deposit(staged.runtime, options(['proj']));
    const after = await loadStore(staged.storeDir);
    expect(again.sessions).toBe(1);
    expect(after.sessions).toHaveLength(4);
    expect(after.prompts.filter((prompt) => prompt.session === 'tldr')).toHaveLength(before.prompts.filter((prompt) => prompt.session === 'tldr').length + 1);
    const raw = readFileSync(paths(staged.storeDir).observations, 'utf8').split('\n').filter((line) => line !== '');
    expect(raw.length).toBeGreaterThan(after.sessions.length + after.prompts.length + after.errors.length);
  });

  it('never writes raw content beyond the truncations: no secrets, no tool inputs, no replies', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    const log = readFileSync(paths(staged.storeDir).observations, 'utf8');
    expect(log).not.toContain('abc123');
    expect(log).not.toContain('FAKEFAKE');
    expect(log).not.toContain('echo ok');
    expect(log).not.toContain('You are welcome');
    expect(log).toContain('token=<secret>');
  });

  it('masks the organization domains it is given', async () => {
    const staged = stage();
    addProject(staged, 'org', 'o1', [JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'deploy to build.corp.example now' } })]);
    await deposit(staged.runtime, { allow: ['org'], redactDomains: ['corp.example'], now: () => NOW });
    expect(readFileSync(paths(staged.storeDir).observations, 'utf8')).toContain('deploy to <org-domain> now');
  });

  it('writes the derived records, one skeleton per session, and stamps the extractor version', async () => {
    const staged = stage();
    await deposit(staged.runtime, options(['proj']));
    expect(readdirSync(paths(staged.storeDir).skeletons).sort()).toEqual(['errors-a.json', 'errors-b.json', 'sidechain.json', 'tldr.json']);
    const store = await loadStore(staged.storeDir);
    const derived = derive(store, 'now');
    const written: unknown = JSON.parse(readFileSync(paths(staged.storeDir).derived, 'utf8'));
    expect(typeof written === 'object' && written !== null && Reflect.get(written, 'sessions')).toBe(4);
    const top = derived.signatures[0];
    expect(top).toMatchObject({ v: '1', tool: 'Bash', sessions: 2, count: 2, harnessVersions: ['2.1.300', '2.1.310'] });
    expect(top?.sig).toContain('unexpected EOF while looking for matching quote');
    expect(top?.following).toEqual({ Write: 1, Read: 1, Bash: 1 });
    expect(derived.classes['edit-verify']?.prompts).toBe(2);
    expect(derived.recovery['Write>Read']).toBe(1);
    expect(derived.bigrams['Read>Bash']).toBe(2);
    expect(derived.summaries.find((summary) => summary.session === 'tldr')).toMatchObject({ prompts: 2, errors: 0, tldrs: 1 });
    expect([...store.sessions, ...store.prompts, ...store.errors].every((observation) => observation.v === '1')).toBe(true);
    expect((await readSkeletons(staged.storeDir, 'tldr')).map((skeleton) => skeleton.session)).toEqual(['tldr']);
  });

  it('reads an empty or missing store as empty', async () => {
    const staged = stage();
    expect(await loadStore(staged.storeDir)).toEqual({ sessions: [], prompts: [], errors: [] });
    expect(await readCalls(staged.storeDir)).toEqual([]);
    expect(await readSkeletons(staged.storeDir)).toEqual([]);
    const missingRoot = { ...staged.runtime, projectsRoot: join(staged.root, 'absent') };
    expect(await deposit(missingRoot, options(['proj']))).toMatchObject({ sessions: 0, skippedFolders: 0, missing: ['proj'] });
  });
});
