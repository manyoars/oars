// CAPTURE 4 (t714): sid, repo, fileHashes, env, promptFingerprint, the line cap, the salt seam, and a version-3 store opened under version 4.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsBooks, sessionsMeasure, sessionsVerify } from './command.js';
import { captureRuntime, oarsVersion, versionIn } from './capture-runtime.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot, normalizeRemote } from './repo-root.js';
import { CAPTURE_VERSION, ERROR_LINE_CHARS, EXTRACTOR_VERSION, FILES_PER_SESSION_MAX } from './schema.js';
import { deposit, loadStore, localSalt, paths, promptHalf, sidOf, type AccountSalt } from './store.js';
import { cleanup, FIXTURES, NOW, stage } from './test-support.js';

afterEach(cleanup);
const redact = makeRedactor();

const parseObject = (text: string): { [key: string]: unknown } => {
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null ? { ...value } : {};
};

/** Applies `change` to each file entry of the store's `state.json`. */
const editState = (storeDir: string, change: (entry: object) => void): void => {
  const state = parseObject(readFileSync(paths(storeDir).state, 'utf8'));
  const files: unknown = state.files;
  for (const entry of typeof files === 'object' && files !== null ? Object.keys(files).map((key): unknown => Reflect.get(files, key)) : []) {
    if (typeof entry === 'object' && entry !== null) change(entry);
  }
  writeFileSync(paths(storeDir).state, JSON.stringify(state));
};

const line = (value: object): string => JSON.stringify(value);
const transcript = (cwd: string, filePath: string, errorText = 'boom'): string =>
  [
    line({ type: 'attachment', uuid: 'a', timestamp: '2026-06-01T00:00:00.000Z', version: '2.1.300', cwd, attachment: { type: 'prompt_snapshot', systemPrompt: 'be brief' } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-06-01T00:00:01.000Z', version: '2.1.300', cwd, message: { role: 'user', content: 'read it' } }),
    line({
      type: 'assistant', uuid: 'u2', timestamp: '2026-06-01T00:00:02.000Z', version: '2.1.301', cwd,
      message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: filePath } }], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    line({ type: 'user', uuid: 'u3', timestamp: '2026-06-01T00:00:03.000Z', version: '2.1.301', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: errorText }] } }),
  ].join('\n');

const capture = (text: string, sid: string | null, root: string | null) =>
  captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact, salt: 'salt', sid, repoRoot: () => root, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' } });

describe('the CAPTURE 4 fields', () => {
  it('stamps sid on every capture record and records env, repo, fileHashes, and promptFingerprint on the session', () => {
    const result = capture(transcript('/w/app/pkg', '/w/app/src/a.ts'), 'abcd1234', '/w/app');
    expect(CAPTURE_VERSION).toBe('4');
    for (const record of [result.session, ...result.prompts, ...result.tools, ...result.errorLines]) expect(record).toMatchObject({ cv: '4', sid: 'abcd1234' });
    expect(result.session.env).toEqual({ harness: '2.1.301', oars: '1.2.3', node: 'v99', os: 'plan9' });
    expect(result.session.repo).toMatch(/^[0-9a-f]{16}$/);
    expect(result.session.fileHashes).toEqual([result.tools[0]?.target]);
    expect(result.tools[0]?.targetBase).toBe('repo');
    expect(result.session.files).toEqual(['/w/app/src/a.ts']);
    expect(result.session.promptFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(result.prompts[0]?.promptFingerprint).toBe(result.session.promptFingerprint);
  });

  it('hashes one file alike from a nested cwd and from the root, and a path outside any repository by its cwd', () => {
    const nested = capture(transcript('/w/app/pkg/cli', '/w/app/src/a.ts'), null, '/w/app');
    const top = capture(transcript('/w/app', 'src/a.ts'), null, '/w/app');
    expect(nested.tools[0]?.target).toBe(top.tools[0]?.target);
    expect(nested.session.repo).toBe(top.session.repo);
    const loose = capture(transcript('/tmp/x', '/tmp/x/n.md'), null, null);
    expect(loose.tools[0]).toMatchObject({ targetBase: 'cwd' });
    expect(loose.session.repo).toBeNull();
  });

  it('caps files and fileHashes per session at the L3 limit', () => {
    const many = Array.from(
      { length: FILES_PER_SESSION_MAX + 5 },
      (_, i) =>
        `{"type":"assistant","uuid":"m${String(i)}","timestamp":"2026-06-01T00:00:02.000Z","cwd":"/w","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t${String(i)}","name":"Read","input":{"file_path":"/w/f${String(i)}.ts"}}],"usage":{"input_tokens":1,"output_tokens":1}}}`,
    ).join('\n');
    const capped = capture(many, null, null);
    expect(capped.session.files).toHaveLength(FILES_PER_SESSION_MAX);
    expect(capped.session.fileHashes).toHaveLength(FILES_PER_SESSION_MAX);
    // Both lists name the same files: the hashes are those of the first 100 paths, not of the first 100 hashes.
    const targetOf = new Map(capped.tools.map((tool, i) => [`/w/f${String(i)}.ts`, tool.target]));
    expect(capped.session.fileHashes).toEqual(capped.session.files.map((path) => targetOf.get(path)).sort());
  });

  it('masks a secret that straddles character 1,000 before the cut, leaving no fragment', () => {
    const text = `${'e'.repeat(990)} sk-A1b2C3d4E5f6G7h8I9j0K1`;
    const result = capture(transcript('/w', '/w/a', text), null, null);
    const kept = result.errorLines[0]?.line ?? '';
    expect(kept).toBe(`${'e'.repeat(990)} <secret>`);
    expect(kept).not.toContain('sk-');
  });

  it('cuts an error line to 1,000 characters after redacting, and runs without sid, runtime, or repo resolver', () => {
    const long = capture(transcript('/w', '/w/a', 'e'.repeat(1500)), null, null);
    expect(Array.from(long.errorLines[0]?.line ?? '')).toHaveLength(ERROR_LINE_CHARS);
    const bare = captureSession({ text: transcript('/w', '/w/a'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact });
    expect(bare.session).toMatchObject({ sid: null, repo: null, env: { oars: '0.0.0', node: process.version, os: process.platform } });
  });
});

describe('repoRoot', () => {
  const exists = (known: string[]) => (path: string) => known.includes(path);
  it('finds the nearest ancestor with .git, strips a worktree segment, caches, and answers null with none', () => {
    const calls: string[] = [];
    const root = makeRepoRoot((path) => {
      calls.push(path);
      return path === '/w/app/.git';
    });
    expect(root('/w/app/packages/cli/')).toBe('/w/app');
    expect(root('/w/app/packages/cli')).toBe('/w/app');
    expect(calls).toEqual(['/w/app/packages/cli/.git', '/w/app/packages/.git', '/w/app/.git']);
    expect(root(String.raw`C:\w\app\.claude\worktrees\t1\src`)).toBe('C:/w/app');
    expect(makeRepoRoot(exists([]))('/nowhere/deep')).toBeNull();
  });
  it('stops at a drive or filesystem root instead of probing the deposit process directory', () => {
    const probed: string[] = [];
    const root = makeRepoRoot((path) => {
      probed.push(path);
      return path === './.git';
    });
    expect(root('C:/tmp/x')).toBeNull();
    expect(probed).toEqual(['C:/tmp/x/.git', 'C:/tmp/.git', 'C:/.git']);
  });
  it('uses the real file system by default', () => {
    expect(makeRepoRoot()(process.cwd())).not.toBeNull();
  });
});

describe('repo identity', () => {
  const files = (known: { [path: string]: string }) => (path: string): string | null => known[path] ?? null;
  const config = (url: string): string => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n[branch "main"]\n\tremote = origin\n`;

  it('normalizes scheme, credentials, a trailing .git and slash, and the host case', () => {
    for (const url of ['https://User:pw@GitHub.com/Org/repo.git', 'git@github.com:Org/repo.git', 'ssh://git@GITHUB.com/Org/repo/', 'github.com/Org/repo']) {
      expect(normalizeRemote(url)).toBe('github.com/Org/repo');
    }
    expect(normalizeRemote('https://host:8443/a/b.git')).toBe('host:8443/a/b');
    expect(normalizeRemote('LOCALHOST')).toBe('localhost');
  });

  it('reads the origin url from a repository with a .git directory', () => {
    const identity = makeRepoIdentity(files({ '/w/app/.git/config': config('git@github.com:org/app.git') }));
    expect(identity('/w/app')).toBe('origin:github.com/org/app');
    expect(identity('/w/app')).toBe('origin:github.com/org/app');
  });

  it('follows a linked worktree .git file through gitdir and commondir to the common config', () => {
    const identity = makeRepoIdentity(
      files({
        '/w/wt/.git': 'gitdir: /w/app/.git/worktrees/wt\n',
        '/w/app/.git/worktrees/wt/commondir': '../..\n',
        '/w/app/.git/config': config('https://github.com/org/app'),
      }),
    );
    expect(identity('/w/wt')).toBe('origin:github.com/org/app');
    const relative = makeRepoIdentity(
      files({ '/w/wt/.git': 'gitdir: ../app/.git/worktrees/wt', '/w/app/.git/worktrees/wt/commondir': '../..', '/w/app/.git/config': config('https://github.com/org/app') }),
    );
    expect(relative('/w/wt')).toBe('origin:github.com/org/app');
    const noCommon = makeRepoIdentity(files({ '/w/wt/.git': 'gitdir: /g/wt', '/g/wt/config': config('https://github.com/org/solo') }));
    expect(noCommon('/w/wt')).toBe('origin:github.com/org/solo');
  });

  it('falls back to the lower-cased root path with no config, no origin, or a broken pointer', () => {
    expect(makeRepoIdentity(files({}))('/W/App')).toBe('path:/w/app');
    expect(makeRepoIdentity(files({ '/w/app/.git/config': '[core]\n\tbare = false\n[remote "upstream"]\n\turl = x\n' }))('/w/app')).toBe('path:/w/app');
    expect(makeRepoIdentity(files({ '/w/app/.git': 'not a pointer' }))('/w/app')).toBe('path:/w/app');
    expect(makeRepoIdentity(files({ '/w/wt/.git': 'gitdir: /nowhere' }))('/w/wt')).toBe('path:/w/wt');
    expect(makeRepoIdentity()('/definitely/not/a/repo')).toBe('path:/definitely/not/a/repo');
  });

  it('gives two clones of one remote the same session repo, and another salt another', () => {
    const repoOf = (root: string, identity: string, salt = 'salt') =>
      captureSession({ text: transcript(root, `${root}/a.ts`), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, salt, repoRoot: () => root, repoIdentity: () => identity }).session.repo;
    expect(repoOf('/a/one', 'origin:github.com/org/app')).toBe(repoOf('/c/elsewhere', 'origin:github.com/org/app'));
    expect(repoOf('/a/one', 'origin:github.com/org/app')).not.toBe(repoOf('/a/one', 'origin:github.com/org/other'));
    expect(repoOf('/a/one', 'origin:github.com/org/app')).not.toBe(repoOf('/a/one', 'origin:github.com/org/app', 'pepper'));
  });
});

describe('a version-3 contextFingerprint', () => {
  it('keeps the prompt half and reads a dash as none', () => {
    expect(promptHalf('-.abc')).toBeNull();
    expect(promptHalf('abc.def')).toBe('abc');
    expect(promptHalf('abc.-')).toBe('abc');
    expect(promptHalf(undefined)).toBeNull();
    expect(promptHalf('')).toBeNull();
  });
});

describe('the capture runtime', () => {
  it('reads this package version and names node and the OS', () => {
    expect(oarsVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(captureRuntime()).toEqual({ oars: oarsVersion(), node: process.version, os: process.platform });
    expect(versionIn('{"version":"4.5.6"}')).toBe('4.5.6');
    expect(versionIn('{}')).toBe('0.0.0');
    expect(versionIn('[]')).toBe('0.0.0');
  });
});

describe('the salt seam', () => {
  it('derives sid from the salt and keeps one local salt per store', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const first = await localSalt(staged.storeDir);
    expect(first.sid).toBe(sidOf(first.salt));
    expect(first.sid).toMatch(/^[0-9a-f]{8}$/);
    expect(await localSalt(staged.storeDir)).toEqual(first);
    expect(sidOf('other')).not.toBe(first.sid);
  });

  it('hashes a path alike in two stores that share a salt, and differently under two salts', async () => {
    const options = { allow: ['proj'], redactDomains: [], now: () => NOW };
    const hashes = async (salt: AccountSalt): Promise<(string | null)[]> => {
      const staged = stage();
      await deposit({ ...staged.runtime, accountSalt: () => Promise.resolve(salt) }, options);
      return (await loadStore(staged.storeDir)).tools.filter((tool) => tool.target !== null && tool.tool === 'Read').map((tool) => tool.target);
    };
    const a = { salt: 'one', sid: sidOf('one') };
    const [x, y, z] = [await hashes(a), await hashes(a), await hashes({ salt: 'two', sid: sidOf('two') })];
    expect(x.length).toBeGreaterThan(0);
    expect(y).toEqual(x);
    expect(z).not.toEqual(x);
  });
});

describe('a version-3 store opened under version 4', () => {
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

  /** Rewrites a version-4 store as version 3 wrote it: no sid, repo, fileHashes, env, or targetBase; `contextFingerprint`; state at `v` 3. */
  const downgrade = (storeDir: string): void => {
    const file = paths(storeDir).observations;
    const old = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => {
      const record = parseObject(entry);
      for (const added of ['sid', 'repo', 'fileHashes', 'env', 'targetBase', 'promptFingerprint']) Reflect.deleteProperty(record, added);
      record.cv = '3';
      return record;
    });
    writeFileSync(file, old.map((record) => `${JSON.stringify(record)}\n`).join(''));
    editState(storeDir, (entry) => {
      Reflect.set(entry, 'v', '3');
      Reflect.deleteProperty(entry, 's');
    });
  };

  it('reads through the compatibility reader, then captures again from the harness at rev + 1 with the same sessions and observations', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    downgrade(staged.storeDir);
    const before = await loadStore(staged.storeDir);
    expect(before.sessions).toHaveLength(4);
    expect(before.sessions[0]).toMatchObject({ cv: '3', sid: null, repo: null, fileHashes: [], env: { oars: 'unknown' } });
    expect(before.tools[0]).toMatchObject({ sid: null, targetBase: null });
    const again = await deposit(staged.runtime, options);
    expect(again).toMatchObject({ sessions: 4, unchanged: 0 });
    const after = await loadStore(staged.storeDir);
    expect(after.sessions.map((session) => session.session)).toEqual(before.sessions.map((session) => session.session));
    expect(after.sessions.every((session) => session.cv === '4' && session.sid !== null)).toBe(true);
    // The pinned window: the same observations, each one revision later (rev + 1).
    const unrev = <T extends { rev: number }>(records: T[]): T[] => records.map((record) => ({ ...record, rev: 0 }));
    expect(unrev(after.prompts)).toEqual(unrev(before.prompts));
    expect(unrev(after.errors)).toEqual(unrev(before.errors));
    expect(after.tools.length).toBe(before.tools.length);
    expect(after.prompts.every((prompt) => prompt.v === EXTRACTOR_VERSION)).toBe(true);
    expect((await deposit(staged.runtime, options)).unchanged).toBe(4);
  });

  it('opens a store captured by 3e658f0 (version 3): only target, targetBase, sid, cv, and rev change on a tool; prompts and errors read equal', async () => {
    const staged = stage();
    cpSync(join(FIXTURES, 'v3-store'), staged.storeDir, { recursive: true });
    const before = await loadStore(staged.storeDir);
    expect(before.sessions.every((session) => session.cv === '3' && session.sid === null && session.promptFingerprint === null)).toBe(true);
    expect(before.tools.every((tool) => tool.sid === null && tool.targetBase === null)).toBe(true);
    await deposit(staged.runtime, options);
    const after = await loadStore(staged.storeDir);
    const key = (record: { session: string; n: number }): string => `${record.session}#${String(record.n)}`;
    const expectedToChange = new Set(['target', 'targetBase', 'sid', 'cv', 'rev']);
    const changed = new Set<string>();
    expect(after.tools.length).toBe(before.tools.length);
    for (const tool of after.tools) {
      const old = before.tools.find((candidate) => key(candidate) === key(tool));
      expect(old).toBeDefined();
      for (const field of new Set([...Object.keys(tool), ...Object.keys(old ?? {})])) {
        if (JSON.stringify(Reflect.get(tool, field)) !== JSON.stringify(Reflect.get(old ?? {}, field))) changed.add(field);
      }
    }
    expect([...changed].filter((field) => !expectedToChange.has(field))).toEqual([]);
    expect(changed.has('sid') && changed.has('targetBase')).toBe(true);
    const unrev = <T extends { rev: number }>(records: T[]): T[] => records.map((record) => ({ ...record, rev: 0 }));
    expect(unrev(after.prompts)).toEqual(unrev(before.prompts));
    expect(unrev(after.errors)).toEqual(unrev(before.errors));
    expect(after.sessions.map((session) => session.promptFingerprint)).toEqual(before.sessions.map((session) => session.promptFingerprint));
  });

  it('captures a transcript the harness no longer has from the raw archive, keeping a subagent origin', async () => {
    const staged = stage();
    const first = await deposit(staged.runtime, options);
    expect(first.sessions).toBe(4);
    const subagentRoot = join(staged.projectsRoot, 'proj', 'tldr', 'subagents');
    mkdirSync(subagentRoot, { recursive: true });
    writeFileSync(join(subagentRoot, 'agent-x.jsonl'), `${transcript('/w', '/w/a')}\n`);
    writeFileSync(join(subagentRoot, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu9' }));
    await deposit(staged.runtime, options);
    downgrade(staged.storeDir);
    for (const name of ['tldr', 'errors-a']) rmSync(join(staged.projectsRoot, 'proj', `${name}.jsonl`));
    rmSync(join(staged.projectsRoot, 'proj', 'tldr'), { recursive: true });
    const again = await deposit(staged.runtime, options);
    expect(again.sessions).toBe(4 - 2 + 2);
    expect(again.subagents).toBe(1);
    const store = await loadStore(staged.storeDir);
    expect(store.sessions.find((session) => session.session === 'tldr')).toMatchObject({ cv: '4' });
    expect(store.subagents[0]).toMatchObject({ session: 'tldr~agent-x', parent: 'tldr', agentType: 'Explore', spawnedBy: 'tu9', cv: '4' });
  });

  it('captures from raw when the harness removed the whole project folder', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    downgrade(staged.storeDir);
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const again = await deposit(staged.runtime, options);
    expect(again.sessions).toBe(4);
    expect((await loadStore(staged.storeDir)).sessions.every((session) => session.cv === '4')).toBe(true);
    expect((await deposit(staged.runtime, options)).sessions).toBe(0);
  });

  it('leaves older records as logged when neither the harness nor the archive has the transcript', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    downgrade(staged.storeDir);
    rmSync(join(staged.projectsRoot, 'proj', 'tldr.jsonl'));
    rmSync(join(paths(staged.storeDir).raw, 'proj', 'tldr.jsonl'));
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).sessions.find((session) => session.session === 'tldr')).toMatchObject({ cv: '3' });
  });

  it('captures a file again when the salt changes, and refuses a store a newer oars wrote', async () => {
    const staged = stage();
    await deposit({ ...staged.runtime, accountSalt: () => Promise.resolve({ salt: 'a', sid: sidOf('a') }) }, options);
    const second = await deposit({ ...staged.runtime, accountSalt: () => Promise.resolve({ salt: 'b', sid: sidOf('b') }) }, options);
    expect(second.sessions).toBe(4);
    editState(staged.storeDir, (entry) => {
      Reflect.set(entry, 'v', '5');
    });
    await expect(deposit(staged.runtime, options)).rejects.toThrow(/upgrade oars/);
  });

  it('reads a line written by a newer capture version for the fields it knows', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    const lines = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => entry.replace('"cv":"4"', '"cv":"5","future":1'));
    writeFileSync(file, `${lines.join('\n')}\n`);
    const store = await loadStore(staged.storeDir);
    expect(store.prompts.length).toBeGreaterThan(0);
    expect(store.newerCaptures).toBe(store.sessions.length);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const notice = /captured by a newer oars; upgrade oars/;
    expect((await sessionsVerify(deps, { session: undefined })).text).toMatch(notice);
    expect((await sessionsMeasure(deps, { last: 50, since: undefined })).text).toMatch(notice);
    expect((await sessionsBooks(deps, { by: 'class', sinceDays: undefined })).text).toMatch(notice);
  });

  it('prints no newer-oars notice for a store of this version', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).newerCaptures).toBe(0);
    expect((await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined })).text).not.toMatch(/newer oars/);
  });
});
