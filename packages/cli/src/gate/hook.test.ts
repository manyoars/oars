import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateHook, registryCachePath, crossingsPath, type GateHookDeps } from './hook.js';
import { indexFile } from './novelty.js';
import { parseRows, type CrossingRecord } from './record.js';
import type { RegistryAnswer, RegistryReader } from './registry.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const folder = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-hook-'));
  made.push(one);
  return one;
};

const NOW = Date.parse('2026-11-04T10:00:00.000Z');

const depsFor = (storeDir: string, extra: Partial<GateHookDeps> = {}): GateHookDeps => ({ storeDir, now: () => NOW, clock: () => 0, deadlineMs: 800, ...extra });

const payload = (command: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse', ...extra });

const rowsOf = (storeDir: string): CrossingRecord[] =>
  parseRows(readFileSync(crossingsPath(storeDir), 'utf8')).filter((row): row is CrossingRecord => row.kind === 'crossing');

const found = (latest: string, created: string | null = '2026-10-30T00:00:00.000Z'): RegistryReader => () => Promise.resolve({ state: 'found', latest, created });

describe('oars gate hook: one record per crossing', () => {
  it('writes the identity, the time, the registry state, and novelty, and reads the rest as not-read', async () => {
    const store = folder();
    expect(await gateHook(payload('npm install left-pad@1.3.0'), depsFor(store, { registry: found('1.3.0') }))).toBe('');
    const [row, ...rest] = rowsOf(store);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      kind: 'crossing',
      via: 'hook',
      day: '2026-11-04',
      class: 'npm-package',
      form: 'install',
      program: 'npm',
      versionForm: 'pinned',
      name: 'left-pad',
      version: '1.3.0',
      session: 's1',
      toolUseId: 'u1',
      ts: '2026-11-04T10:00:00.000Z',
      permission: 'default',
      novelty: 'fleet',
      depth: 'main',
      agent: null,
      registryState: 'found',
      againstLatest: 'latest',
      registryAge: 'under-7-days',
      arm: 'none',
      lineShown: 'none',
      origin: 'not-read',
      decidedBy: 'not-read',
      status: 'not-read',
      next: 'not-read',
      removedLater: 'not-read',
      miss: 'not-read',
    });
  });

  it('writes one row for each name a call installs, and marks a subagent', async () => {
    const store = folder();
    await gateHook(payload('npm install a-lib b-lib', { agent_id: 'sub1' }), depsFor(store));
    expect(rowsOf(store).map((row) => [row.name, row.depth, row.agent])).toEqual([
      ['a-lib', 'subagent', 'sub1'],
      ['b-lib', 'subagent', 'sub1'],
    ]);
  });

  it('records an MCP call and a Skill call', async () => {
    const store = folder();
    await gateHook(JSON.stringify({ session_id: 's1', tool_use_id: 'u2', tool_name: 'mcp__handy__search', tool_input: {}, cwd: tmpdir() }), depsFor(store));
    await gateHook(JSON.stringify({ session_id: 's1', tool_use_id: 'u3', tool_name: 'Skill', tool_input: { skill: 'review' }, cwd: tmpdir() }), depsFor(store));
    expect(rowsOf(store).map((row) => [row.class, row.form, row.name, row.permission])).toEqual([
      ['mcp-server', 'mcp-call', 'handy', 'unknown'],
      ['skill', 'skill-call', 'review', 'unknown'],
    ]);
  });

  it('reads novelty from the kept index: fleet, then none, then session, then repository', async () => {
    const store = folder();
    const repoOne = folder();
    const repoTwo = folder();
    mkdirSync(join(repoOne, '.git'));
    mkdirSync(join(repoTwo, '.git'));
    const run = (session: string, cwd: string) => gateHook(payload('npm install left-pad', { session_id: session, cwd, tool_use_id: `${session}-${cwd.slice(-4)}` }), depsFor(store));
    await run('s1', repoOne);
    await run('s1', repoOne);
    await run('s2', repoOne);
    await run('s2', repoTwo);
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['fleet', 'none', 'session', 'repository']);
    // The index holds hashes: no name, session, or folder in it.
    const index = readFileSync(indexFile(store), 'utf8');
    expect(index).not.toMatch(/left-pad|s1|s2|oars-gate-hook-/);
  });

  it('counts a worktree and a subfolder as their repository', async () => {
    const store = folder();
    const repo = folder();
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    mkdirSync(join(repo, '.claude', 'worktrees', 'w1'), { recursive: true });
    await gateHook(payload('npm install left-pad', { session_id: 'a', cwd: repo }), depsFor(store));
    await gateHook(payload('npm install left-pad', { session_id: 'b', cwd: join(repo, 'src', 'deep') }), depsFor(store));
    await gateHook(payload('npm install left-pad', { session_id: 'c', cwd: join(repo, '.claude', 'worktrees', 'w1') }), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['fleet', 'session', 'session']);
  });

  it('uses a kept registry answer first, and asks again once it is older than a day', async () => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('2.0.0'));
    await gateHook(payload('npm install left-pad', { tool_use_id: 'a' }), depsFor(store, { registry: reader }));
    await gateHook(payload('npm install left-pad', { tool_use_id: 'b' }), depsFor(store, { registry: reader }));
    expect(reader).toHaveBeenCalledTimes(1);
    expect(rowsOf(store).map((row) => row.registryState)).toEqual(['found', 'found']);
    await gateHook(payload('npm install left-pad', { tool_use_id: 'c' }), depsFor(store, { registry: reader, now: () => NOW + 3 * 86_400_000 }));
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('keeps a not-found answer and does not keep an unreachable one', async () => {
    const store = folder();
    const answers: RegistryAnswer[] = [{ state: 'unreachable', latest: null, created: null }, { state: 'not-found', latest: null, created: null }];
    const reader = vi.fn<RegistryReader>(() => Promise.resolve(answers.shift() ?? { state: 'unreachable', latest: null, created: null }));
    await gateHook(payload('npm install ghost-lib', { tool_use_id: 'a' }), depsFor(store, { registry: reader }));
    await gateHook(payload('npm install ghost-lib', { tool_use_id: 'b' }), depsFor(store, { registry: reader }));
    await gateHook(payload('npm install ghost-lib', { tool_use_id: 'c' }), depsFor(store, { registry: reader }));
    expect(rowsOf(store).map((row) => row.registryState)).toEqual(['unreachable', 'not-found', 'not-found']);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(readFileSync(registryCachePath(store), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('asks nothing for a manager whose registry the gate cannot name, a URL, or a folder that is gone', async () => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('1.0.0'));
    await gateHook(payload('yarn add left-pad', { tool_use_id: 'a' }), depsFor(store, { registry: reader }));
    await gateHook(payload('npm install github:owner/repo', { tool_use_id: 'b' }), depsFor(store, { registry: reader }));
    await gateHook(payload('npm install left-pad', { tool_use_id: 'c', cwd: join(store, 'gone') }), depsFor(store, { registry: reader }));
    await gateHook(payload('npm install left-pad --registry https://example.test', { tool_use_id: 'd' }), depsFor(store, { registry: reader }));
    expect(reader).not.toHaveBeenCalled();
    expect(rowsOf(store).map((row) => row.registryState)).toEqual(['not-read', 'not-read', 'not-read', 'not-read']);
  });

  it('applies the organization domains a deposit saved', async () => {
    const store = folder();
    writeFileSync(join(store, 'state.json'), JSON.stringify({ redactDomains: ['corp.example'] }));
    await gateHook(payload('npm install git+https://git.corp.example/team/lib.git'), depsFor(store));
    expect(rowsOf(store).map((row) => row.name)).toEqual(['https://<org-domain>/team/lib.git']);
  });
});

describe('oars gate hook: npx of a bin the folder has', () => {
  const project = (): string => {
    const one = folder();
    mkdirSync(join(one, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(one, 'node_modules', '.bin', 'tsc'), '');
    mkdirSync(join(one, 'src'), { recursive: true });
    return one;
  };

  it('records local-bin-run, and asks the registry nothing, for a present bin and the bin of a parent folder', async () => {
    const store = folder();
    const ask = vi.fn(found('5.4.0'));
    const one = project();
    await gateHook(payload('npx tsc --noEmit', { cwd: one, tool_use_id: 'u1' }), depsFor(store, { registry: ask }));
    await gateHook(payload('npx tsc', { cwd: join(one, 'src'), tool_use_id: 'u2' }), depsFor(store, { registry: ask }));
    expect(rowsOf(store).map((row) => [row.form, row.registryState])).toEqual([
      ['local-bin-run', 'not-read'],
      ['local-bin-run', 'not-read'],
    ]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('records an absent bin, and a pinned one, as a fetch-and-run and asks about it', async () => {
    const store = folder();
    const ask = vi.fn(found('9.9.9'));
    const one = project();
    await gateHook(payload('npx eslint', { cwd: one, tool_use_id: 'u1' }), depsFor(store, { registry: ask }));
    await gateHook(payload('npx tsc@5.0.0', { cwd: one, tool_use_id: 'u2' }), depsFor(store, { registry: ask }));
    expect(rowsOf(store).map((row) => [row.form, row.registryState])).toEqual([
      ['fetch-and-run', 'found'],
      ['fetch-and-run', 'found'],
    ]);
  });
});

describe('oars gate hook: a call that crosses nothing', () => {
  it.each([['ls -la'], ['npm ci'], ['git status'], ['echo npm install not-a-crossing | cat']])('writes nothing and asks nothing for %s', async (command) => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('1.0.0'));
    expect(await gateHook(payload(command), depsFor(store, { registry: reader }))).toBe('');
    expect(existsSync(crossingsPath(store))).toBe(false);
    expect(existsSync(indexFile(store))).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  it('writes nothing for a tool outside the three', async () => {
    const store = folder();
    await gateHook(JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'x' } }), depsFor(store));
    expect(existsSync(store + '/crossings.jsonl')).toBe(false);
  });
});

describe('oars gate hook: every path ends with empty output', () => {
  const crossing = payload('npm install left-pad');
  const paths: [string, () => { stdin: string; deps: (store: string) => GateHookDeps }][] = [
    ['malformed stdin', () => ({ stdin: '{"tool_name": "Bash", ', deps: (store) => depsFor(store) })],
    ['empty stdin', () => ({ stdin: '', deps: (store) => depsFor(store) })],
    ['a JSON array', () => ({ stdin: '[1,2]', deps: (store) => depsFor(store) })],
    ['JSON null', () => ({ stdin: 'null', deps: (store) => depsFor(store) })],
    ['no session', () => ({ stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }), deps: (store) => depsFor(store) })],
    ['a tool_input of the wrong type', () => ({ stdin: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: 7 }), deps: (store) => depsFor(store) })],
    ['a store that does not exist yet', () => ({ stdin: crossing, deps: (store) => depsFor(join(store, 'not', 'there', 'yet')) })],
    [
      'a store that is a file',
      () => ({
        stdin: crossing,
        deps: (store) => {
          writeFileSync(join(store, 'file'), 'x');
          return depsFor(join(store, 'file'));
        },
      }),
    ],
    [
      'a full disk',
      () => ({
        stdin: crossing,
        deps: (store) =>
          depsFor(store, {
            append: () => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
          }),
      }),
    ],
    [
      'a thrown error',
      () => ({
        stdin: crossing,
        deps: (store) =>
          depsFor(store, {
            now: () => {
              throw new Error('clock broke');
            },
          }),
      }),
    ],
    ['a registry that rejects', () => ({ stdin: crossing, deps: (store) => depsFor(store, { registry: () => Promise.reject(new Error('registry down')) }) })],
    ['a damaged index', () => ({ stdin: crossing, deps: (store) => {
      writeFileSync(indexFile(store), 'not an index\n');
      return depsFor(store);
    } })],
  ];

  it.each(paths)('%s', async (_name, build) => {
    const store = folder();
    const { stdin, deps } = build();
    const output = await gateHook(stdin, deps(store));
    expect(output).toBe('');
    // No output of any path carries a decision or a rewritten input.
    expect(output).not.toContain('permissionDecision');
    expect(output).not.toContain('updatedInput');
  });

  it('never returns a decision for a call that records', async () => {
    const store = folder();
    const output = await gateHook(crossing, depsFor(store, { registry: found('1.0.0') }));
    expect(output).toBe('');
    expect(output).not.toMatch(/permissionDecision|updatedInput|decision/);
  });
});

describe('oars gate hook: a damaged index', () => {
  it('reads not-read for novelty and is left as it is', async () => {
    const store = folder();
    writeFileSync(indexFile(store), 'garbage\n');
    await gateHook(payload('npm install left-pad'), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['not-read']);
    expect(readFileSync(indexFile(store), 'utf8')).toBe('garbage\n');
  });

  it.each([['an empty file', ''], ['a line outside the grammar', 'oars-gate-index 1\nfabc\n'], ['a line from another version', 'oars-gate-index 2\nf0123456789ab\n']])('treats %s as damaged', async (_name, body) => {
    const store = folder();
    writeFileSync(indexFile(store), body);
    await gateHook(payload('npm install left-pad'), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['not-read']);
  });

  it('ignores a torn last line and a repeated header', async () => {
    const store = folder();
    await gateHook(payload('npm install left-pad', { tool_use_id: 'a' }), depsFor(store));
    appendFileSync(indexFile(store), 'oars-gate-index 1\nf0123');
    await gateHook(payload('npm install left-pad', { tool_use_id: 'b' }), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['fleet', 'none']);
  });

  it('is not seeded, and says so, when a record exists without one', async () => {
    const store = folder();
    writeFileSync(crossingsPath(store), '{"kind":"run","v":1}\n');
    await gateHook(payload('npm install left-pad'), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['not-read']);
    expect(existsSync(indexFile(store))).toBe(false);
  });
});

describe('oars gate hook: the deadline', () => {
  it('returns inside the deadline with the registry not read when the registry stalls', async () => {
    const store = folder();
    const started = performance.now();
    const stalled: RegistryReader = () => new Promise<RegistryAnswer>(() => undefined);
    const output = await gateHook(payload('npm install left-pad'), depsFor(store, { registry: stalled, clock: () => performance.now(), deadlineMs: performance.now() + 500 }));
    expect(output).toBe('');
    expect(performance.now() - started).toBeLessThan(500);
    expect(rowsOf(store).map((row) => [row.registryState, row.againstLatest, row.registryAge])).toEqual([['not-read', 'not-read', 'not-read']]);
  });

  it('does not start an ask with no time left', async () => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('1.0.0'));
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry: reader, clock: () => 790 }));
    expect(reader).not.toHaveBeenCalled();
    expect(rowsOf(store)).toHaveLength(1);
  });
});
