import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEADLINE_ENV, DEADLINE_MS, deadlineOf, gateHook, registryCachePath, crossingsPath, type GateHookDeps } from './hook.js';
import { indexFile } from './novelty.js';
import { folderKey, parseRows, type CrossingRecord } from './record.js';
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

/** The fields of the harness's payload these tests set beside the command. */
interface HookPayload {
  session_id: string;
  tool_use_id: string;
  cwd: string;
  agent_id: string;
}

const payload = (command: string, extra: Partial<HookPayload> = {}): string =>
  JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse', ...extra });

const rowsOf = (storeDir: string): CrossingRecord[] =>
  parseRows(readFileSync(crossingsPath(storeDir), 'utf8')).filter((row): row is CrossingRecord => row.kind === 'crossing');

const found = (latest: string, created: string | null = '2020-01-01T00:00:00.000Z'): RegistryReader => () => Promise.resolve({ state: 'found', latest, created });

describe('oars gate hook: one record per crossing', () => {
  it('writes the identity, the time, the registry state, and novelty, and reads the rest as not-read', async () => {
    const store = folder();
    expect(await gateHook(payload('npm install left-pad@1.3.0'), depsFor(store, { registry: found('1.3.0', '2026-10-30T00:00:00.000Z'), random: () => 0 }))).toBe('');
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
      arm: 'held',
      lineShown: 'none',
      lineHeld: 'young-name-note',
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

describe('oars gate hook: the policy a row was written under', () => {
  it('records default with no file, file for one that fits, and invalid for one that does not, and writes the row in each case', async () => {
    const store = folder();
    await gateHook(payload('npm install left-pad', { tool_use_id: 'a' }), depsFor(store));
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    await gateHook(payload('npm install left-pad', { tool_use_id: 'b' }), depsFor(store));
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"deny"}}');
    expect(await gateHook(payload('npm install left-pad', { tool_use_id: 'c' }), depsFor(store))).toBe('');
    expect(rowsOf(store).map((row) => row.policy)).toEqual(['default', 'file', 'invalid']);
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

  it.each([['an empty file', ''], ['a line outside the grammar', 'oars-gate-index 1\nfabc\n'], ['a line from another version', 'oars-gate-index 2\nf0123456789ab\n'], ['a line of another shape before a later one', 'oars-gate-index 1\nzzz\nf0123456789ab\n']])('treats %s as damaged', async (_name, body) => {
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

  it('costs one torn line, not the index, when the next new name appends after it', async () => {
    const store = folder();
    await gateHook(payload('npm install left-pad', { tool_use_id: 'a' }), depsFor(store));
    appendFileSync(indexFile(store), 'f0123');
    await gateHook(payload('npm install right-pad', { tool_use_id: 'b' }), depsFor(store));
    await gateHook(payload('npm install right-pad', { tool_use_id: 'c' }), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['fleet', 'fleet', 'none']);
  });

  it('reads the index when two hooks racing on a torn tail left an empty line', async () => {
    const store = folder();
    writeFileSync(indexFile(store), 'oars-gate-index 1\nf0123\n\nf0123456789ab\n');
    await gateHook(payload('npm install left-pad'), depsFor(store));
    expect(rowsOf(store).map((row) => row.novelty)).toEqual(['fleet']);
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
    const output = await gateHook(payload('npm install left-pad'), depsFor(store, { registry: stalled, clock: () => performance.now(), deadlineMs: performance.now() + 2_000 }));
    expect(output).toBe('');
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(rowsOf(store).map((row) => [row.registryState, row.againstLatest, row.registryAge])).toEqual([['not-read', 'not-read', 'not-read']]);
  });

  it('does not start an ask with no time left', async () => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('1.0.0'));
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry: reader, clock: () => 790 }));
    expect(reader).not.toHaveBeenCalled();
    expect(rowsOf(store)).toHaveLength(1);
  });

  it('keeps 800 ms unless the environment names a larger whole number of ms', () => {
    expect(DEADLINE_MS).toBe(800);
    expect(deadlineOf({})).toBe(DEADLINE_MS);
    expect(deadlineOf({ [DEADLINE_ENV]: '6000' })).toBe(6000);
    for (const given of ['', 'soon', '800', '100', '-5', '6000.5', 'Infinity']) expect(deadlineOf({ [DEADLINE_ENV]: given })).toBe(DEADLINE_MS);
  });
});

describe('oars gate hook: one ask per name', () => {
  it('does not ask while the name is locked, and hands nothing over', async () => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('1.0.0'));
    const fill = vi.fn<NonNullable<GateHookDeps['fill']>>(() => Promise.resolve());
    const locked = vi.fn<NonNullable<GateHookDeps['locked']>>(() => Promise.resolve(true));
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry: reader, fill, locked }));
    expect(locked).toHaveBeenCalledWith({ class: 'npm-package', name: 'left-pad', cwd: tmpdir() });
    expect(reader).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(rowsOf(store).map((row) => row.registryState)).toEqual(['not-read']);
  });

  it('asks when the name is not locked, and a lock check that throws does not stop the ask', async () => {
    const store = folder();
    const reader = vi.fn<RegistryReader>(found('1.0.0'));
    await gateHook(payload('npm install left-pad', { tool_use_id: 'a' }), depsFor(store, { registry: reader, locked: () => Promise.resolve(false) }));
    await gateHook(payload('npm install other-lib', { tool_use_id: 'b' }), depsFor(store, { registry: reader, locked: () => Promise.reject(new Error('no store')) }));
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('stops its own ask before it hands the name over, so the manager is never asked twice at once', async () => {
    const store = folder();
    let signal: AbortSignal | undefined;
    const registry: RegistryReader = (ask) => {
      signal = ask.signal;
      return new Promise<RegistryAnswer>(() => undefined);
    };
    const aborted: boolean[] = [];
    const fill = vi.fn<NonNullable<GateHookDeps['fill']>>(() => {
      aborted.push(signal?.aborted ?? false);
      return Promise.resolve();
    });
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry, clock: () => 0, deadlineMs: 400, fill }));
    expect(signal).toBeDefined();
    expect(aborted).toEqual([true]);
  });

  it('cuts an ask at once when starting it used up the budget, and stops it, hands the name over, and writes the row', async () => {
    const store = folder();
    let now = 0;
    let signal: AbortSignal | undefined;
    // The manager's start blocks: by the time the registry call returns, the clock is past the 30 s deadline. The budget was read before the call and was whole, so reading it there would wait out the whole of it.
    const registry: RegistryReader = (ask) => {
      signal = ask.signal;
      now = 30_100;
      return new Promise<RegistryAnswer>(() => undefined);
    };
    const fill = vi.fn<NonNullable<GateHookDeps['fill']>>(() => Promise.resolve());
    const started = Date.now();
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry, clock: () => now, deadlineMs: 30_000, fill }));
    // The old code read the budget before the call and waited out about 29.9 s; the bound is half of that, so a loaded box cannot reach it.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(signal?.aborted).toBe(true);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(rowsOf(store).map((row) => row.registryState)).toEqual(['not-read']);
  });

  it('stages the rows so far and a not-read row for the crossing asked about, with a stop for the ask, while the ask is live', async () => {
    const store = folder();
    const staged: ({ text: string; stop?: () => void } | null)[] = [];
    let signal: AbortSignal | undefined;
    const registry: RegistryReader = (ask) => {
      signal = ask.signal;
      // The record staged at this moment is what a process cut off here writes.
      const live = staged.at(-1);
      const held = parseRows(live?.text ?? '').filter((row): row is CrossingRecord => row.kind === 'crossing');
      expect(held.map((row) => row.name)).toEqual(['first-lib', 'left-pad']);
      expect(held[1]).toMatchObject({ registryState: 'not-read', arm: 'none', lineShown: 'none', lineHeld: 'none' });
      live?.stop?.();
      return Promise.resolve({ state: 'found', latest: '1.0.0', created: '2020-01-01T00:00:00.000Z' });
    };
    const stage: NonNullable<GateHookDeps['stage']> = (pending) => {
      staged.push(pending);
    };
    // `first-lib` is kept in the cache, so it is read without an ask and the ask is for `left-pad` alone.
    const kept = { kind: 'registry', v: 1, day: new Date(NOW).toISOString().slice(0, 10), ts: new Date(NOW).toISOString(), folder: folderKey(tmpdir()), class: 'npm-package', state: 'found', created: null, name: 'first-lib', latest: '1.0.0' };
    writeFileSync(registryCachePath(store), `${JSON.stringify(kept)}\n`);
    await gateHook(payload('npm install first-lib left-pad'), depsFor(store, { registry, stage }));
    expect(signal?.aborted).toBe(true);
    // Cleared after the cached name, staged for the ask, cleared when it ended, then the final record, then cleared once written.
    expect(staged.map((pending) => (pending === null ? null : pending.text.trim().split('\n').length))).toEqual([null, 2, null, 2, null]);
    expect(rowsOf(store).map((row) => [row.name, row.registryState])).toEqual([['first-lib', 'found'], ['left-pad', 'found']]);
  });

  it('leaves an ask that answered alone', async () => {
    const store = folder();
    let signal: AbortSignal | undefined;
    const registry: RegistryReader = (ask) => {
      signal = ask.signal;
      return found('1.0.0')(ask);
    };
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry }));
    expect(signal?.aborted).toBe(false);
  });
});

describe('oars gate hook: finishing a cut ask', () => {
  const stalled: RegistryReader = () => new Promise<RegistryAnswer>(() => undefined);

  it('hands the name to the fill when the ask is cut, and again when there was no time to start it', async () => {
    const store = folder();
    const fill = vi.fn<NonNullable<GateHookDeps['fill']>>(() => Promise.resolve());
    await gateHook(payload('npm install left-pad'), depsFor(store, { registry: stalled, clock: () => 0, deadlineMs: 400, fill }));
    await gateHook(payload('npm install left-pad', { tool_use_id: 'b' }), depsFor(store, { registry: stalled, clock: () => 790, fill }));
    expect(fill).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledWith({ class: 'npm-package', name: 'left-pad', cwd: tmpdir() });
    expect(rowsOf(store).map((row) => row.registryState)).toEqual(['not-read', 'not-read']);
  });

  it('starts at most three helpers in one call, and leaves the other names to a later sight', async () => {
    const store = folder();
    const fill = vi.fn<NonNullable<GateHookDeps['fill']>>(() => Promise.resolve());
    const names = Array.from({ length: 20 }, (_, at) => `lib-${String(at)}`);
    await gateHook(payload(`npm install ${names.join(' ')}`), depsFor(store, { registry: stalled, clock: () => 790, fill }));
    expect(fill.mock.calls.map(([ask]) => ask.name)).toEqual(['lib-0', 'lib-1', 'lib-2']);
    expect(rowsOf(store)).toHaveLength(20);
    await gateHook(payload('npm install lib-3', { tool_use_id: 'b' }), depsFor(store, { registry: stalled, clock: () => 790, fill }));
    expect(fill).toHaveBeenCalledTimes(4);
  });

  it('does not hand over a name whose answer came, was kept, or could not be asked', async () => {
    const store = folder();
    const fill = vi.fn<NonNullable<GateHookDeps['fill']>>(() => Promise.resolve());
    await gateHook(payload('npm install left-pad', { tool_use_id: 'a' }), depsFor(store, { registry: found('1.0.0'), fill }));
    await gateHook(payload('npm install left-pad', { tool_use_id: 'b' }), depsFor(store, { registry: stalled, fill }));
    await gateHook(payload('yarn add other-lib', { tool_use_id: 'c' }), depsFor(store, { registry: stalled, fill }));
    await gateHook(payload('npm install third-lib', { tool_use_id: 'd' }), depsFor(store, { fill }));
    expect(fill).not.toHaveBeenCalled();
  });

  it('keeps the row and its empty output when the fill throws', async () => {
    const store = folder();
    const fill = (): Promise<void> => Promise.reject(new Error('lock failed'));
    expect(await gateHook(payload('npm install left-pad'), depsFor(store, { registry: stalled, clock: () => 0, deadlineMs: 400, fill }))).toBe('');
    expect(rowsOf(store)).toHaveLength(1);
  });
});

// Class A names, versions, and session ids: the store is the user's, and every other write in it is 0600.
describe('oars gate hook: the files it creates', () => {
  it.skipIf(process.platform === 'win32')('creates the record, the registry answers, and the index private to the user', async () => {
    const store = folder();
    await gateHook(payload('npm install left-pad@1.3.0'), depsFor(store, { registry: found('1.3.0') }));
    for (const file of [crossingsPath(store), registryCachePath(store), indexFile(store)]) {
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).mode & 0o777, file).toBe(0o600);
    }
  });
});
