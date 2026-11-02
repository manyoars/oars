// CAPTURE 4 (t714): sid, repo, fileHashes, env, promptFingerprint, the line cap, the salt seam, and a version-3 store opened under version 4.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureRuntime, oarsVersion, versionIn } from './capture-runtime.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoRoot } from './repo-root.js';
import { CAPTURE_VERSION, ERROR_LINE_CHARS, EXTRACTOR_VERSION, FILES_PER_SESSION_MAX } from './schema.js';
import { deposit, loadStore, localSalt, paths, sidOf, type AccountSalt } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

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
  it('uses the real file system by default', () => {
    expect(makeRepoRoot()(process.cwd())).not.toBeNull();
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
    expect((await loadStore(staged.storeDir)).prompts.length).toBeGreaterThan(0);
  });
});
