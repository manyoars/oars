// CAPTURE 4: sid, repo, fileHashes, env, promptFingerprint, the line cap, the salt seam, and a version-3 store opened under version 4.
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsBooks, sessionsMeasure, sessionsVerify } from './command.js';
import { captureRuntime, oarsVersion, versionIn } from './capture-runtime.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot, normalizeRemote } from './repo-root.js';
import { CAPTURE_VERSION, ERROR_LINE_CHARS, EXTRACTOR_VERSION, FILES_PER_SESSION_MAX, type PromptVerify } from './schema.js';
import { deposit, depositSession, loadStore, localSalt, paths, promptHalf, sidOf, type AccountSalt } from './store.js';
import { recall } from './query.js';
import { addProject, cleanup, FIXTURES, NOW, stage, stageRawCursor } from './test-support.js';

afterEach(cleanup);
const redact = makeRedactor();

const parseObject = (text: string): { [key: string]: unknown } => {
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null ? { ...value } : {};
};

/** Applies `change` to each file entry of the store's `state.json`, with the entry's key (the transcript's path under the projects root). */
const editState = (storeDir: string, change: (entry: object, key: string) => void): void => {
  const state = parseObject(readFileSync(paths(storeDir).state, 'utf8'));
  const files: unknown = state.files;
  if (typeof files === 'object' && files !== null) {
    for (const key of Object.keys(files)) {
      const entry: unknown = Reflect.get(files, key);
      if (typeof entry === 'object' && entry !== null) change(entry, key);
    }
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
    expect(CAPTURE_VERSION).toBe('22');
    for (const record of [result.session, ...result.prompts, ...result.tools, ...result.errorLines]) expect(record).toMatchObject({ cv: CAPTURE_VERSION, sid: 'abcd1234' });
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
    // The cap keeps the alphabetically first paths, so the last-sorting one is gone (and `recall --path` no longer sees it).
    const kept = new Set(capped.session.files);
    const dropped = Array.from({ length: FILES_PER_SESSION_MAX + 5 }, (_, i) => `/w/f${String(i)}.ts`).filter((path) => !kept.has(path));
    expect(dropped).toHaveLength(5);
    expect(dropped.every((path) => path > (capped.session.files.at(-1) ?? ''))).toBe(true);
    // Both lists name the same files: the hashes are those of the first 100 paths, not of the first 100 hashes.
    const targetOf = new Map(capped.tools.map((tool, i) => [`/w/f${String(i)}.ts`, tool.target]));
    expect(capped.session.fileHashes).toEqual(capped.session.files.map((path) => targetOf.get(path)).sort());
  });

  const readAt = (cwd: string, filePath: string, id: string): string =>
    `{"type":"assistant","uuid":"r${id}","timestamp":"2026-06-01T00:00:02.000Z","cwd":"${cwd}","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t${id}","name":"Read","input":{"file_path":"${filePath}"}}],"usage":{"input_tokens":1,"output_tokens":1}}}`;
  const captureWith = (text: string, repoRoot: (cwd: string) => string | null) =>
    captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact, salt: 'salt', sid: null, repoRoot });

  it('lists a file once in fileHashes when its root path and its linked-worktree path hash alike, and never emits an empty hash', () => {
    const text = [readAt('/w/app', '/w/app/src/a.ts', '1'), readAt('/w/app/.claude/worktrees/t1', '/w/app/.claude/worktrees/t1/src/a.ts', '2')].join('\n');
    const result = captureWith(text, () => '/w/app');
    expect(result.session.files).toHaveLength(2);
    expect(result.session.fileHashes).toHaveLength(1);
    expect(result.session.fileHashes.every((hash) => /^[0-9a-f]{16}$/.test(hash))).toBe(true);
  });

  it('keeps every hash of one relative path that names two files (read from a subdirectory and from a root), as the spec lists the hash of each file', () => {
    const text = [readAt('/r1/pkg', 'a.ts', '1'), readAt('/r2', 'a.ts', '2')].join('\n');
    const result = captureWith(text, (cwd) => (cwd === '/r1/pkg' ? '/r1' : cwd));
    expect(result.session.files).toEqual(['a.ts']);
    expect(result.session.fileHashes).toHaveLength(2);
    expect(result.session.fileHashes).toEqual(result.tools.map((tool) => tool.target).sort());
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

describe('a capped session', () => {
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

  it('finds a kept file of a really capped session by recall --path, and no dropped one', async () => {
    const staged = stage();
    const reads = Array.from({ length: FILES_PER_SESSION_MAX + 5 }, (_, i) =>
      line({
        type: 'assistant', uuid: `m${String(i)}`, timestamp: '2026-06-01T00:00:02.000Z', cwd: '/w',
        message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `t${String(i)}`, name: 'Read', input: { file_path: `/w/f${String(i)}.ts` } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    );
    const failure = line({ type: 'user', uuid: 'e1', timestamp: '2026-06-01T00:00:03.000Z', cwd: '/w', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', is_error: true, content: 'boom' }] } });
    addProject(staged, 'proj', 'capped', [...reads, failure]);
    await deposit(staged.runtime, options);
    const store = await loadStore(staged.storeDir);
    const session = store.sessions.find((candidate) => candidate.session === 'capped');
    expect(session?.files).toHaveLength(FILES_PER_SESSION_MAX);
    const kept = session?.files[0] ?? '';
    const dropped = Array.from({ length: FILES_PER_SESSION_MAX + 5 }, (_, i) => `/w/f${String(i)}.ts`).find((path) => !session?.files.includes(path)) ?? '';
    expect(recall(store, { path: kept }, NOW).matches.length).toBeGreaterThan(0);
    expect(dropped).not.toBe('');
    expect(recall(store, { path: dropped }, NOW).matches).toHaveLength(0);
  });
});

describe('the setup, funnel, and trust shape in the store', () => {
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

  it('survives a deposit and loadStore: the record written is the record read back', async () => {
    const staged = stage();
    const stamp = (seconds: number): string => new Date(Date.UTC(2026, 5, 1, 0, 0, seconds)).toISOString();
    const lines = [
      line({ type: 'permission-mode', permissionMode: 'plan', sessionId: 's' }),
      line({ type: 'user', uuid: 'h1', timestamp: stamp(0), version: '2.1.318', cwd: '/w', message: { role: 'user', content: 'go' } }),
      line({ type: 'attachment', uuid: 'd1', timestamp: stamp(1), version: '2.1.318', cwd: '/w', attachment: { type: 'deferred_tools_delta', addedNames: ['Read', 'Grep'], removedNames: ['Grep'] } }),
      line({
        type: 'assistant', uuid: 'a1', timestamp: stamp(60), version: '2.1.318', cwd: '/w',
        message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      line({
        type: 'user', uuid: 'r1', timestamp: stamp(61), version: '2.1.318', cwd: '/w',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] },
      }),
    ];
    addProject(staged, 'proj', 'shaped', lines);
    await deposit(staged.runtime, options);
    const store = await loadStore(staged.storeDir);
    const session = store.sessions.find((candidate) => candidate.session === 'shaped');
    expect(session?.setup).toEqual({ permissionMode: 'plan' });
    expect(session?.funnel).toEqual({ offered: ['Read'], removed: ['Grep'] });
    expect(session?.trust).toMatchObject({ interrupts: 0, rejections: 1, denials: 0, unattendedRun: [1], trustEvent: [{ event: 'rejection', tool: 'Read', prompt: 0 }] });
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

describe('a version-17 store gaining call attribution', () => {
  it('re-captures unchanged transcripts so calls carry model and skill', async () => {
    const staged = stage();
    const options = { allow: ['proj'], redactDomains: [], now: () => NOW };
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    const old = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => {
      const record = parseObject(entry);
      record.cv = '17';
      if (record.kind === 'tool') {
        Reflect.deleteProperty(record, 'model');
        Reflect.deleteProperty(record, 'skill');
      }
      return JSON.stringify(record);
    });
    writeFileSync(file, `${old.join('\n')}\n`);
    editState(staged.storeDir, (entry) => Reflect.set(entry, 'v', '17'));
    expect((await loadStore(staged.storeDir)).tools.every((tool) => tool.model === undefined)).toBe(true);
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 4, unchanged: 0 });
    const after = await loadStore(staged.storeDir);
    expect(after.tools.find((tool) => tool.session === 'tldr')).toMatchObject({ cv: CAPTURE_VERSION, model: 'claude-opus-5-5', skill: 'deep-dive' });
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
    expect(before.sessions[0]).toMatchObject({ cv: '3', sid: null, repo: null, fileHashes: [], env: { harness: null, oars: 'unknown' } });
    expect(before.tools[0]).toMatchObject({ sid: null, targetBase: null });
    const again = await deposit(staged.runtime, options);
    expect(again).toMatchObject({ sessions: 4, unchanged: 0 });
    const after = await loadStore(staged.storeDir);
    expect(after.sessions.map((session) => session.session)).toEqual(before.sessions.map((session) => session.session));
    expect(after.sessions.every((session) => session.cv === CAPTURE_VERSION && session.sid !== null)).toBe(true);
    // The pinned window: the same observations, each one revision later (rev + 1).
    const unrev = <T extends { rev: number }>(records: T[]): T[] => records.map((record) => ({ ...record, rev: 0 }));
    // `downgrade` leaves `segments` in place, so `verify` reads alike on both sides.
    const verifyOfFirst = (prompts: typeof before.prompts): PromptVerify | undefined => prompts.find((prompt) => prompt.session === 'errors-a' && prompt.index === 0)?.verify;
    expect(verifyOfFirst(before.prompts)).toBe('passed');
    expect(verifyOfFirst(after.prompts)).toBe('passed');
    expect(unrev(after.prompts)).toEqual(unrev(before.prompts));
    expect(unrev(after.errors)).toEqual(unrev(before.errors));
    expect(after.tools.length).toBe(before.tools.length);
    expect(after.prompts.every((prompt) => prompt.v === EXTRACTOR_VERSION)).toBe(true);
    expect((await deposit(staged.runtime, options)).unchanged).toBe(4);
  });

  it('opens a store captured by 3e658f0 (version 3): only target, targetBase, sid, cv, rev, and the CAPTURE 6 fields change on a tool; prompts read equal but for verify and frame, and errors read equal', async () => {
    const staged = stage();
    cpSync(join(FIXTURES, 'v3-store'), staged.storeDir, { recursive: true });
    const before = await loadStore(staged.storeDir);
    expect(before.sessions.every((session) => session.cv === '3' && session.sid === null && session.promptFingerprint === null)).toBe(true);
    expect(before.tools.every((tool) => tool.sid === null && tool.targetBase === null)).toBe(true);
    await deposit(staged.runtime, options);
    const after = await loadStore(staged.storeDir);
    const key = (record: { session: string; n: number }): string => `${record.session}#${String(record.n)}`;
    const expectedToChange = new Set(['steps', 'target', 'targetBase', 'sid', 'cv', 'rev', 'segments', 'pulls', 'commits', 'errorCode', 'model', 'skill', 'targetClass', 'argClass']);
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
    // A version-3 record has no `segments`, so `verify` is absent where a shell call follows the edit, and captured again it reads.
    const verifyAt = (prompts: typeof before.prompts, session: string, index: number): PromptVerify | undefined =>
      prompts.find((prompt) => prompt.session === session && prompt.index === index)?.verify;
    expect(verifyAt(before.prompts, 'errors-a', 0)).toBeUndefined();
    expect(verifyAt(after.prompts, 'errors-a', 0)).toBe('passed');
    expect(verifyAt(before.prompts, 'errors-b', 0)).toBeUndefined();
    expect(verifyAt(after.prompts, 'errors-b', 0)).toBe('none');
    expect(verifyAt(before.prompts, 'tldr', 0)).toBe('na');
    expect(verifyAt(after.prompts, 'tldr', 0)).toBe('na');
    // A version-3 record has no frame or strata either, and a prompt's derived record carries the ones capture now writes.
    expect(before.prompts.every((prompt) => prompt.frame === undefined)).toBe(true);
    expect(after.prompts.every((prompt) => prompt.frame !== undefined)).toBe(true);
    expect(before.prompts.every((prompt) => prompt.strata === undefined)).toBe(true);
    expect(after.prompts.every((prompt) => prompt.strata !== undefined)).toBe(true);
    const unverified = <T extends { rev: number }>(records: T[]): T[] => unrev(records).map((record) => ({ ...record, verify: null, frame: null, strata: null, usageObserved: undefined, usageResponses: undefined }));
    expect(unverified(after.prompts)).toEqual(unverified(before.prompts));
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
    expect(store.sessions.find((session) => session.session === 'tldr')).toMatchObject({ cv: CAPTURE_VERSION });
    expect(store.subagents[0]).toMatchObject({ session: 'tldr~agent-x', parent: 'tldr', agentType: 'Explore', spawnedBy: 'tu9', cv: CAPTURE_VERSION });
  });

  it('captures from raw when the harness removed the whole project folder', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    downgrade(staged.storeDir);
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const again = await deposit(staged.runtime, options);
    expect(again.sessions).toBe(4);
    expect((await loadStore(staged.storeDir)).sessions.every((session) => session.cv === CAPTURE_VERSION)).toBe(true);
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
      Reflect.set(entry, 'v', String(Number(CAPTURE_VERSION) + 1));
    });
    await expect(deposit(staged.runtime, options)).rejects.toThrow(/upgrade oars/);
  });

  it('refuses on the Stop-hook path too, and leaves the log and state as they were', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    editState(staged.storeDir, (entry, key) => {
      if (key.endsWith('tldr.jsonl')) Reflect.set(entry, 'v', String(Number(CAPTURE_VERSION) + 1));
    });
    const before = readFileSync(paths(staged.storeDir).observations);
    const stateBefore = readFileSync(paths(staged.storeDir).state);
    await expect(depositSession(staged.runtime, join(staged.projectsRoot, 'proj', 'errors-a.jsonl'), () => NOW)).rejects.toThrow(/upgrade oars/);
    expect(readFileSync(paths(staged.storeDir).observations).equals(before)).toBe(true);
    expect(readFileSync(paths(staged.storeDir).state).equals(stateBefore)).toBe(true);
  });

  it('refuses before any append: an older entry sorted first is not captured again when a later one is newer', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    editState(staged.storeDir, (entry, key) => {
      if (key.endsWith('errors-a.jsonl')) Reflect.set(entry, 'v', '3');
      if (key.endsWith('tldr.jsonl')) Reflect.set(entry, 'v', String(Number(CAPTURE_VERSION) + 1));
    });
    const before = readFileSync(paths(staged.storeDir).observations);
    await expect(deposit(staged.runtime, options)).rejects.toThrow(/upgrade oars/);
    expect(readFileSync(paths(staged.storeDir).observations).equals(before)).toBe(true);
  });

  it('refuses a deposit when the log holds a newer cv even though state.json is current, and leaves the log as it was', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    writeFileSync(file, readFileSync(file, 'utf8').replace(`"cv":"${CAPTURE_VERSION}"`, `"cv":"${String(Number(CAPTURE_VERSION) + 1)}"`));
    const before = readFileSync(file);
    await expect(deposit(staged.runtime, options)).rejects.toThrow(/upgrade oars/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('counts a session as newer only when its highest rev is, as the full load does', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    const lines = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '');
    const sessionLines = lines.filter((entry) => entry.includes('"kind":"session"'));
    expect(sessionLines.length).toBeGreaterThan(1);
    const newer = String(Number(CAPTURE_VERSION) + 1);
    const parse = (entry: string): object => {
      const parsed: unknown = JSON.parse(entry);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    };
    const copy = (entry: string, rev: number, cv: string): string => JSON.stringify({ ...parse(entry), rev, cv });
    const parsedRev = parse(sessionLines[0] ?? '');
    const first = { rev: 'rev' in parsedRev && typeof parsedRev.rev === 'number' ? parsedRev.rev : 0 };
    // A newer oars wrote an older rev of the session; a current rev followed it. The current one is the session as a reader sees it.
    writeFileSync(file, `${[copy(sessionLines[0] ?? '', first.rev - 1, newer), ...lines].join('\n')}\n`);
    expect((await loadStore(staged.storeDir)).newerCaptures).toBe(0);
    await expect(deposit(staged.runtime, options)).resolves.toBeDefined();
    // The newer record is the highest rev: both counts see it, and the deposit refuses.
    appendFileSync(file, `${copy(sessionLines[0] ?? '', first.rev + 1, newer)}\n`);
    expect((await loadStore(staged.storeDir)).newerCaptures).toBe(1);
    await expect(deposit(staged.runtime, options)).rejects.toThrow(/sessions: 1\)/);
  });

  it('reads a line written by a newer capture version for the fields it knows', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    const lines = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => entry.replace(`"cv":"${CAPTURE_VERSION}"`, `"cv":"${String(Number(CAPTURE_VERSION) + 1)}","future":1`));
    writeFileSync(file, `${lines.join('\n')}\n`);
    const store = await loadStore(staged.storeDir);
    expect(store.prompts.length).toBeGreaterThan(0);
    expect(store.newerCaptures).toBe(store.sessions.length);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const notice = /captured by a newer oars; upgrade oars/;
    const verified = await sessionsVerify(deps, { session: undefined });
    const measured = await sessionsMeasure(deps, { last: 50, since: undefined });
    const booked = await sessionsBooks(deps, { by: 'class', sinceDays: undefined });
    for (const outcome of [verified, measured, booked]) {
      expect(outcome.text).toMatch(notice);
      expect(outcome.document).toMatchObject({ newerCaptures: store.newerCaptures });
    }
  });

  it('prints no newer-oars notice for a store of this version', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).newerCaptures).toBe(0);
    expect((await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined })).text).not.toMatch(/newer oars/);
  });
});

describe('a deposit over a version-4 store', () => {
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

  it('captures every transcript again at the current version and writes the model keys a version-4 skeleton lacks', async () => {
    const staged = stage();
    const main = readdirSync(join(staged.projectsRoot, 'proj')).find((name) => name.endsWith('.jsonl')) ?? '';
    const cost = line({ type: 'cost-state', startTime: Date.parse('2026-06-01T00:00:00.000Z'), modelUsage: { 'claude-haiku-4-5': { inputTokens: 3, outputTokens: 2 } } });
    appendFileSync(join(staged.projectsRoot, 'proj', main), `${cost}\n`);
    await deposit(staged.runtime, options);
    // A version-4 store: records and state at 4, and each skeleton's models as the bare names version 4 wrote.
    const file = paths(staged.storeDir).observations;
    const old = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => ({ ...parseObject(entry), cv: '4' }));
    writeFileSync(file, old.map((record) => `${JSON.stringify(record)}\n`).join(''));
    editState(staged.storeDir, (entry) => {
      Reflect.set(entry, 'v', '4');
    });
    const folder = paths(staged.storeDir).skeletons;
    const costed = (): string[] => readdirSync(folder).filter((name) => readFileSync(join(folder, name), 'utf8').includes('claude-haiku-4-5'));
    expect(costed()).toHaveLength(1);
    const name = costed()[0] ?? '';
    const skeleton = parseObject(readFileSync(join(folder, name), 'utf8'));
    const lines: unknown = skeleton.lines;
    if (Array.isArray(lines)) for (const entry of lines) if (typeof entry === 'object' && entry !== null && Reflect.get(entry, 'costState') !== null && Reflect.get(entry, 'costState') !== undefined) Reflect.set(Reflect.get(entry, 'costState'), 'models', ['claude-haiku-4-5']);
    Reflect.set(skeleton, 'v', '4');
    writeFileSync(join(folder, name), JSON.stringify(skeleton));
    expect(readFileSync(join(folder, name), 'utf8')).not.toContain('"keys"');
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 4 });
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.cv)).toEqual(Array(4).fill(CAPTURE_VERSION));
    expect(readFileSync(join(folder, name), 'utf8')).toContain('"models":[{"model":"claude-haiku-4-5","keys":["input","output"]}]');
  });
});

describe('a deposit over a version-9 store', () => {
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

  it('fails --strict as cv-behind, then captures every transcript again at the current version', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    const old = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => ({ ...parseObject(entry), cv: '9' }));
    writeFileSync(file, old.map((record) => `${JSON.stringify(record)}\n`).join(''));
    editState(staged.storeDir, (entry) => {
      Reflect.set(entry, 'v', '9');
    });
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    expect((await sessionsVerify(deps, { session: undefined })).failed).toContain('every session is captured at the current capture version (none is cv-behind)');
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 4 });
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.cv)).toEqual(Array(4).fill(CAPTURE_VERSION));
  });
});

describe('a cv-behind session whose transcript is gone (cv-frozen)', () => {
  const options = { allow: ['proj'], redactDomains: [], now: () => NOW };
  const behind = 'every session is captured at the current capture version (none is cv-behind)';

  /** Rewrites the store as a version-4 oars left it: every captured record and state entry at 4. */
  const atVersion4 = (storeDir: string): void => {
    const file = paths(storeDir).observations;
    const old = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => ({ ...parseObject(entry), cv: '4' }));
    writeFileSync(file, old.map((record) => `${JSON.stringify(record)}\n`).join(''));
    editState(storeDir, (entry) => {
      Reflect.set(entry, 'v', '4');
    });
  };

  it('passes --strict and is counted cv-frozen when neither the harness nor raw/ has the transcript', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    atVersion4(staged.storeDir);
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    rmSync(join(paths(staged.storeDir).raw, 'proj'), { recursive: true });
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).not.toContain(behind);
    expect(verified.report.cvFrozen).toBe(4);
    expect(verified.text).toMatch(/4 cv-frozen sessions/);
    expect(verified.document).toMatchObject({ cvFrozen: 4 });
  });

  it('still fails --strict when the source exists: a harness transcript, or a raw/ copy', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    atVersion4(staged.storeDir);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const fromHarness = await sessionsVerify(deps, { session: undefined });
    expect(fromHarness.failed).toContain(behind);
    expect(fromHarness.report.cvFrozen).toBe(0);
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const fromRaw = await sessionsVerify(deps, { session: undefined });
    expect(fromRaw.failed).toContain(behind);
    expect(fromRaw.report.cvFrozen).toBe(0);
  });

  it('still fails --strict when state.json is lost but the transcripts are still in the harness', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    atVersion4(staged.storeDir);
    rmSync(paths(staged.storeDir).state);
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).toContain(behind);
    expect(verified.report.cvFrozen).toBe(0);
    expect(verified.text).not.toMatch(/cv-frozen sessions/);
  });

  it('still fails --strict for a live subagent transcript when state.json is lost, and counts it frozen once the transcript is gone', async () => {
    const staged = stage();
    const subagentRoot = join(staged.projectsRoot, 'proj', 'tldr', 'subagents');
    mkdirSync(join(subagentRoot, 'workflows', 'wf_y'), { recursive: true });
    writeFileSync(join(subagentRoot, 'agent-x.jsonl'), `${transcript('/w', '/w/a')}
`);
    writeFileSync(join(subagentRoot, 'workflows', 'wf_y', 'agent-z.jsonl'), `${transcript('/w', '/w/a')}
`);
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).subagents.map((subagent) => subagent.session).sort()).toEqual(['tldr~agent-x', 'tldr~wf_y~agent-z']);
    atVersion4(staged.storeDir);
    rmSync(paths(staged.storeDir).state);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const live = await sessionsVerify(deps, { session: undefined });
    expect(live.failed).toContain(behind);
    expect(live.report.cvFrozen).toBe(0);
    rmSync(join(staged.projectsRoot, 'proj', 'tldr'), { recursive: true });
    rmSync(join(paths(staged.storeDir).raw, 'proj', 'tldr'), { recursive: true });
    expect((await sessionsVerify(deps, { session: undefined })).report.cvFrozen).toBe(2);
  });

  it('captures a raw-only session again after state.json and the harness project are lost, instead of failing --strict for good', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    atVersion4(staged.storeDir);
    rmSync(paths(staged.storeDir).state);
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const lost = await sessionsVerify(deps, { session: undefined });
    expect(lost.failed).toContain(behind);
    expect(lost.report.cvFrozen).toBe(0);
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 4 });
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.cv)).toEqual(Array(4).fill(CAPTURE_VERSION));
    const healed = await sessionsVerify(deps, { session: undefined });
    expect(healed.failed).not.toContain(behind);
    expect(healed.report.cvFrozen).toBe(0);
  });

  describe('a Cursor session (its source is the composer, not a transcript file)', () => {
    const doc = (composerId: string) => ({ composerId, createdAt: 1, conversation: [{ type: 1, text: 'hi' }] });
    const cursorOptions = { allow: ['cursor'], redactDomains: [], now: () => NOW };

    it('fails --strict with behind while Cursor still lists the composer', async () => {
      const staged = stage();
      const user = await stageRawCursor(staged.root, [{ id: 'live', document: doc('live') }], []);
      const runtime = { ...staged.runtime, cursorRoot: user };
      await deposit(runtime, cursorOptions);
      atVersion4(staged.storeDir);
      const verified = await sessionsVerify({ sessions: runtime, install: undefined, now: () => NOW }, { session: undefined });
      expect(verified.failed).toContain(behind);
      expect(verified.report.cvFrozen).toBe(0);
    });

    it('counts cv-frozen once the composer is gone from Cursor', async () => {
      const staged = stage();
      const user = await stageRawCursor(staged.root, [{ id: 'live', document: doc('live') }], []);
      await deposit({ ...staged.runtime, cursorRoot: user }, cursorOptions);
      atVersion4(staged.storeDir);
      const other = await stageRawCursor(join(staged.root, 'other'), [{ id: 'different', document: doc('different') }], []);
      const verified = await sessionsVerify({ sessions: { ...staged.runtime, cursorRoot: other }, install: undefined, now: () => NOW }, { session: undefined });
      expect(verified.failed).not.toContain(behind);
      expect(verified.report.cvFrozen).toBe(1);
    });

    it('fails --strict with behind for a composer under a workspace folder while Cursor still lists it', async () => {
      const staged = stage();
      const app = join(staged.root, 'work', 'app');
      mkdirSync(app, { recursive: true });
      const user = await stageRawCursor(staged.root, [{ id: 'live', document: doc('live') }], [{ json: { folder: pathToFileURL(app).href }, listed: ['live'] }]);
      const runtime = { ...staged.runtime, cursorRoot: user };
      await deposit(runtime, cursorOptions);
      expect((await loadStore(staged.storeDir)).sessions.map((session) => session.project)).toEqual([expect.stringMatching(/work-app$/)]);
      atVersion4(staged.storeDir);
      const verified = await sessionsVerify({ sessions: runtime, install: undefined, now: () => NOW }, { session: undefined });
      expect(verified.failed).toContain(behind);
      expect(verified.report.cvFrozen).toBe(0);
    });

    it('counts cv-frozen when the Cursor store file is gone', async () => {
      const staged = stage();
      const user = await stageRawCursor(staged.root, [{ id: 'live', document: doc('live') }], []);
      const runtime = { ...staged.runtime, cursorRoot: user };
      await deposit(runtime, cursorOptions);
      atVersion4(staged.storeDir);
      rmSync(join(user, 'globalStorage', 'state.vscdb'));
      const verified = await sessionsVerify({ sessions: runtime, install: undefined, now: () => NOW }, { session: undefined });
      expect(verified.failed).not.toContain(behind);
      expect(verified.report.cvFrozen).toBe(1);
    });

    it('counts cv-frozen when the runtime names no Cursor store', async () => {
      const staged = stage();
      const user = await stageRawCursor(staged.root, [{ id: 'live', document: doc('live') }], []);
      await deposit({ ...staged.runtime, cursorRoot: user }, cursorOptions);
      atVersion4(staged.storeDir);
      const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
      expect(verified.failed).not.toContain(behind);
      expect(verified.report.cvFrozen).toBe(1);
    });

    it('counts an unreadable Cursor store as alive', async () => {
      const staged = stage();
      const user = await stageRawCursor(staged.root, [{ id: 'live', document: doc('live') }], []);
      await deposit({ ...staged.runtime, cursorRoot: user }, cursorOptions);
      atVersion4(staged.storeDir);
      writeFileSync(join(user, 'globalStorage', 'state.vscdb'), 'this is not a database');
      const verified = await sessionsVerify({ sessions: { ...staged.runtime, cursorRoot: user }, install: undefined, now: () => NOW }, { session: undefined });
      expect(verified.failed).toContain(behind);
      expect(verified.report.cvFrozen).toBe(0);
    });
  });
});
