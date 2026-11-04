import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossingsPath, type GateHookDeps } from './hook.js';
import { runHookProcess } from './hook-process.js';
import type { RegistryAnswer } from './registry.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const folder = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-process-'));
  made.push(one);
  return one;
};

const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const PAYLOAD = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' }, cwd: tmpdir(), permission_mode: 'default' });

const depsFor =
  (storeDir: string, extra: Partial<GateHookDeps> = {}) =>
  (stage: NonNullable<GateHookDeps['stage']>): GateHookDeps => ({ storeDir, now: () => NOW, clock: () => 0, deadlineMs: 800, stage, ...extra });

describe('the hook process: the deadline', () => {
  it('writes the staged record and exits 0 inside the deadline when the append stalls', async () => {
    const store = folder();
    const exit = vi.fn();
    const stalled = (): Promise<void> => new Promise<void>(() => undefined);
    const started = Date.now();
    // The returned promise never settles: the append never does. The timer is what ends the process.
    void runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { append: stalled }), exit, deadlineMs: 150 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); }, { timeout: 2_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(exit).toHaveBeenCalledTimes(1);
    const lines = readFileSync(crossingsPath(store), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'crossing', via: 'hook', name: 'left-pad', session: 's1' });
  });

  it.each([
    ['shown', 0.5],
    ['held', 0],
  ])('writes a %s note row as no exposure at the deadline, since nothing was printed', async (_arm, draw) => {
    const store = folder();
    const exit = vi.fn();
    const found = (): Promise<RegistryAnswer> => Promise.resolve({ state: 'found', latest: '1.0.0', created: '2026-10-30T00:00:00.000Z' });
    void runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { append: () => new Promise<void>(() => undefined), registry: found, random: () => draw }), exit, deadlineMs: 300 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); }, { timeout: 2_000 });
    const lines = readFileSync(crossingsPath(store), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ name: 'left-pad', arm: 'none', lineShown: 'none', lineHeld: 'none' });
  });

  it('writes a staged block row as no exposure at the deadline, since the deny never printed', async () => {
    const store = folder();
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    const exit = vi.fn();
    const missing = (): Promise<RegistryAnswer> => Promise.resolve({ state: 'not-found', latest: null, created: null });
    void runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { append: () => new Promise<void>(() => undefined), registry: missing }), exit, deadlineMs: 300 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); }, { timeout: 2_000 });
    const lines = readFileSync(crossingsPath(store), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ name: 'left-pad', arm: 'none', lineShown: 'none', lineHeld: 'none' });
  });

  it.skipIf(process.platform === 'win32')('creates the staged file private to the user', async () => {
    const store = folder();
    const exit = vi.fn();
    void runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { append: () => new Promise<void>(() => undefined) }), exit, deadlineMs: 100 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalled(); }, { timeout: 2_000 });
    expect(statSync(crossingsPath(store)).mode & 0o777).toBe(0o600);
  });

  it('stops a registry ask still running at the deadline, and leaves one not-read row', async () => {
    const store = folder();
    const exit = vi.fn();
    let signal: AbortSignal | undefined;
    const registry = (ask: { signal?: AbortSignal }): Promise<RegistryAnswer> => {
      signal = ask.signal;
      return new Promise<RegistryAnswer>(() => undefined);
    };
    // The hook's own cut is 650 ms away and the process deadline 150 ms: the deadline is what ends the process, with the ask live.
    void runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { registry }), exit, deadlineMs: 150 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); }, { timeout: 2_000 });
    expect(signal?.aborted).toBe(true);
    const lines = readFileSync(crossingsPath(store), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'crossing', name: 'left-pad', registryState: 'not-read', arm: 'none' });
  });

  it('still writes the row when stopping the ask throws', async () => {
    const store = folder();
    const exit = vi.fn();
    const stage = (put: NonNullable<GateHookDeps['stage']>): void => {
      put({ file: crossingsPath(store), text: `${JSON.stringify({ kind: 'crossing', name: 'left-pad' })}\n`, stop: () => { throw new Error('no such process'); } });
    };
    void runHookProcess({ stdin: () => new Promise<string>(() => undefined), deps: (put) => { stage(put); return depsFor(store)(put); }, exit, deadlineMs: 100 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); }, { timeout: 2_000 });
    expect(readFileSync(crossingsPath(store), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('drops a staged record whose write fails and still exits 0', async () => {
    const store = folder();
    const exit = vi.fn();
    // The store folder is never made (the append that would make it stalls), so the synchronous write has nowhere to go.
    void runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(join(store, 'missing', 'deeper'), { append: () => new Promise<void>(() => undefined) }), exit, deadlineMs: 100 });
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); }, { timeout: 2_000 });
    expect(existsSync(join(store, 'missing'))).toBe(false);
  });

  it('writes nothing at the deadline once the record is on disk', async () => {
    const store = folder();
    const exit = vi.fn();
    // The deadline is short, and the test waits until it has passed: a timer that still held the staged record would append it a second time.
    await runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store), exit, deadlineMs: 150 });
    expect(exit).toHaveBeenCalledWith(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(crossingsPath(store), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the hook process: every failure exits 0', () => {
  it('exits 0 when building the deps throws', async () => {
    const exit = vi.fn();
    const broken = (): GateHookDeps => {
      throw new Error('no home folder');
    };
    await runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: broken, exit, deadlineMs: 5_000 });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 0 when reading stdin rejects', async () => {
    const store = folder();
    const exit = vi.fn();
    await runHookProcess({ stdin: () => Promise.reject(new Error('closed')), deps: depsFor(store), exit, deadlineMs: 5_000 });
    expect(exit).toHaveBeenCalledWith(0);
    expect(existsSync(crossingsPath(store))).toBe(false);
  });

  it('exits 0 when stdin throws before it returns a promise', async () => {
    const exit = vi.fn();
    const sync = (): Promise<string> => {
      throw new Error('setEncoding is not a function');
    };
    await runHookProcess({ stdin: sync, deps: depsFor(folder()), exit, deadlineMs: 5_000 });
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('the hook process: the answer on stdout', () => {
  const missing = (): Promise<RegistryAnswer> => Promise.resolve({ state: 'not-found', latest: null, created: null });

  it('hands the hook output to `write` before it exits, when the policy blocks', async () => {
    const store = folder();
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    const order: string[] = [];
    const write = vi.fn<(text: string) => Promise<void>>(() => {
      order.push('write');
      return Promise.resolve();
    });
    const exit = vi.fn<(code: number) => void>(() => {
      order.push('exit');
    });
    await runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { registry: missing }), exit, write, deadlineMs: 5_000 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? '')).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(order).toEqual(['write', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('writes nothing when the hook has nothing to say', async () => {
    const write = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const exit = vi.fn();
    const old = (): Promise<RegistryAnswer> => Promise.resolve({ state: 'found', latest: '1.0.0', created: '2020-01-01T00:00:00.000Z' });
    await runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(folder(), { registry: old }), exit, write, deadlineMs: 5_000 });
    expect(write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits 0 when `write` rejects', async () => {
    const store = folder();
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    const exit = vi.fn();
    await runHookProcess({ stdin: () => Promise.resolve(PAYLOAD), deps: depsFor(store, { registry: missing }), exit, write: () => Promise.reject(new Error('closed pipe')), deadlineMs: 5_000 });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
