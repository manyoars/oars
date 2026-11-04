// What the hook says back: a note as additional context, a block as a deny with a label, the arm each row was in, and what the hook never does.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossingsPath, gateHook, registryCachePath, type GateHookDeps } from './hook.js';
import { parseRows, type CrossingRecord } from './record.js';
import type { RegistryAnswer, RegistryReader } from './registry.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const folder = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-notes-'));
  made.push(one);
  return one;
};

const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const depsFor = (storeDir: string, extra: Partial<GateHookDeps> = {}): GateHookDeps => ({ storeDir, now: () => NOW, clock: () => 0, deadlineMs: 800, ...extra });
const payload = (command: string, id = 'u1'): string =>
  JSON.stringify({ session_id: 's1', tool_use_id: id, tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse' });
const rowsOf = (storeDir: string): CrossingRecord[] =>
  parseRows(readFileSync(crossingsPath(storeDir), 'utf8')).filter((row): row is CrossingRecord => row.kind === 'crossing');
const withPolicy = (store: string, body: string): void => {
  writeFileSync(join(store, 'gate-policy.json'), body);
};

const found = (created: string | null = '2026-10-30T00:00:00.000Z'): RegistryReader => () => Promise.resolve({ state: 'found', latest: '1.0.0', created });
const OLD = '2020-01-01T00:00:00.000Z';
const missing: RegistryReader = () => Promise.resolve({ state: 'not-found', latest: null, created: null });
const unreachable: RegistryReader = () => Promise.resolve({ state: 'unreachable', latest: null, created: null });
const stalled: RegistryReader = () => new Promise<RegistryAnswer>(() => undefined);

const additional = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
const deny = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const NOTE = 'Registry note: left-pad was first published 5 days ago in the registry your package manager uses.';
const REASON = 'Blocked by your gate policy: ghost-lib was not found in the registry your package manager uses.';

describe('oars gate hook: a note, and the arm it is shown in', () => {
  it('shows a young name as additional context, and records the arm and the line id', async () => {
    const store = folder();
    expect(await gateHook(payload('npm install left-pad'), depsFor(store, { registry: found(), random: () => 0.5 }))).toBe(additional(NOTE));
    expect(rowsOf(store)).toMatchObject([{ arm: 'shown', lineShown: 'young-name-note', registryAge: 'under-7-days' }]);
  });

  it('shows nothing for a held note, and records the line it withheld apart from the line shown', async () => {
    const store = folder();
    expect(await gateHook(payload('npm install left-pad'), depsFor(store, { registry: found(), random: () => 0 }))).toBe('');
    expect(rowsOf(store)).toMatchObject([{ arm: 'held', lineShown: 'none', lineHeld: 'young-name-note' }]);
  });

  it('draws with Math.random when no draw is handed in', async () => {
    const store = folder();
    const output = await gateHook(payload('npm install left-pad'), depsFor(store, { registry: found() }));
    expect(['', additional(NOTE)]).toContain(output);
    expect(rowsOf(store)[0]?.arm).toMatch(/^(shown|held)$/);
  });

  it('is silent, with arm none, for an old name, an unreadable registry, and a name the policy turns off', async () => {
    const store = folder();
    expect(await gateHook(payload('npm install left-pad', 'a'), depsFor(store, { registry: found(OLD), random: () => 0.5 }))).toBe('');
    expect(await gateHook(payload('npm install right-pad', 'b'), depsFor(store, { registry: unreachable, random: () => 0.5 }))).toBe('');
    withPolicy(store, '{"classes":{"young-name":"off"}}');
    expect(await gateHook(payload('npm install new-pad', 'c'), depsFor(store, { registry: found(), random: () => 0.5 }))).toBe('');
    expect(rowsOf(store).map((row) => [row.arm, row.lineShown])).toEqual([
      ['none', 'none'],
      ['none', 'none'],
      ['none', 'none'],
    ]);
  });

  it('notes a name seen in this session only once, and joins the notes of one call', async () => {
    const store = folder();
    const deps = (): GateHookDeps => depsFor(store, { registry: found(), random: () => 0.5 });
    expect(await gateHook(payload('npm install left-pad', 'a'), deps())).toBe(additional(NOTE));
    expect(await gateHook(payload('npm install left-pad', 'b'), deps())).toBe('');
    const both = await gateHook(payload('npm install alpha-lib beta-lib', 'c'), deps());
    expect(both).toBe(
      additional(
        'Registry note: alpha-lib was first published 5 days ago in the registry your package manager uses.\nRegistry note: beta-lib was first published 5 days ago in the registry your package manager uses.',
      ),
    );
  });

  it('notes a name the registry does not hold by default, and an invalid policy file leaves that as it is', async () => {
    const store = folder();
    withPolicy(store, 'not json');
    const output = await gateHook(payload('npm install ghost-lib'), depsFor(store, { registry: missing, random: () => 0.5 }));
    expect(JSON.parse(output)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Registry note: ghost-lib was not found in the registry your package manager uses.' } });
    expect(rowsOf(store)).toMatchObject([{ arm: 'shown', lineShown: 'not-found-note', policy: 'invalid' }]);
  });
});

describe('oars gate hook: a block, as a label', () => {
  it('denies a name not found only when the policy says block, with a label that states the fact', async () => {
    const store = folder();
    expect(await gateHook(payload('npm install ghost-lib', 'a'), depsFor(store, { registry: missing, random: () => 0.5 }))).not.toContain('deny');
    withPolicy(store, '{"classes":{"not-found":"block"}}');
    expect(await gateHook(payload('npm install ghost-lib', 'b'), depsFor(store, { registry: missing, random: () => 0.5 }))).toBe(deny(REASON));
    expect(rowsOf(store).map((row) => [row.arm, row.lineShown])).toEqual([
      ['shown', 'not-found-note'],
      ['none', 'not-found-block'],
    ]);
  });

  it('still blocks when the draw is forced to held, since a holdback is for notes only', async () => {
    const store = folder();
    withPolicy(store, '{"classes":{"not-found":"block"},"holdbackPercent":100}');
    expect(await gateHook(payload('npm install ghost-lib'), depsFor(store, { registry: missing, random: () => 0 }))).toBe(deny(REASON));
    expect(rowsOf(store)).toMatchObject([{ arm: 'none', lineShown: 'not-found-block', lineHeld: 'none' }]);
  });

  it('records the withheld line per class, so arms can be compared line by line', async () => {
    const store = folder();
    withPolicy(store, '{"holdbackPercent":100}');
    expect(await gateHook(payload('npm install ghost-lib'), depsFor(store, { registry: missing, random: () => 0 }))).toBe('');
    expect(rowsOf(store)).toMatchObject([{ arm: 'held', lineShown: 'none', lineHeld: 'not-found-note' }]);
  });

  it('never blocks on a reading it does not have: a cut ask, no time to ask, an unreachable registry, or a manager it cannot ask', async () => {
    const store = folder();
    withPolicy(store, '{"classes":{"not-found":"block"}}');
    expect(await gateHook(payload('npm install ghost-lib', 'a'), depsFor(store, { registry: stalled, clock: () => 0, deadlineMs: 400 }))).toBe('');
    expect(await gateHook(payload('npm install ghost-lib', 'b'), depsFor(store, { registry: missing, clock: () => 790 }))).toBe('');
    expect(await gateHook(payload('npm install ghost-lib', 'c'), depsFor(store, { registry: unreachable }))).toBe('');
    expect(await gateHook(payload('yarn add ghost-lib', 'd'), depsFor(store, { registry: missing }))).toBe('');
    expect(rowsOf(store).every((row) => row.arm === 'none' && row.lineShown === 'none')).toBe(true);
  });

  it('blocks on a not-found answer kept a minute ago, and asks again once it is ten minutes old', async () => {
    const store = folder();
    withPolicy(store, '{"classes":{"not-found":"block"}}');
    const kept = { kind: 'registry', v: 1, day: '2026-11-04', ts: new Date(NOW - 60_000).toISOString(), class: 'npm-package', state: 'not-found', created: null, name: 'ghost-lib', latest: null };
    writeFileSync(registryCachePath(store), `${JSON.stringify(kept)}\n`);
    const reader = vi.fn<RegistryReader>(found(OLD));
    expect(await gateHook(payload('npm install ghost-lib', 'a'), depsFor(store, { registry: reader }))).toBe(deny(REASON));
    expect(reader).not.toHaveBeenCalled();
    expect(await gateHook(payload('npm install ghost-lib', 'b'), depsFor(store, { registry: reader, now: () => NOW + 10 * 60_000 }))).toBe('');
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('asks again for a cached not-found answer with no time on it, as an earlier build wrote them', async () => {
    const store = folder();
    const kept = { kind: 'registry', v: 1, day: '2026-11-04', class: 'npm-package', state: 'not-found', created: null, name: 'ghost-lib', latest: null };
    writeFileSync(registryCachePath(store), `${JSON.stringify(kept)}\n`);
    const reader = vi.fn<RegistryReader>(found(OLD));
    await gateHook(payload('npm install ghost-lib'), depsFor(store, { registry: reader }));
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('never approves or rewrites a call: no allow, no ask, no changed input, whatever the policy or the reading', async () => {
    const store = folder();
    withPolicy(store, '{"classes":{"not-found":"block","young-name":"warn"},"holdbackPercent":0}');
    const outputs: string[] = [];
    for (const [at, reader] of [missing, found(), found(OLD), unreachable].entries()) {
      outputs.push(await gateHook(payload(`npm install lib-${String(at)}`, String(at)), depsFor(store, { registry: reader })));
    }
    expect(outputs.filter((output) => output !== '')).toHaveLength(2);
    for (const output of outputs) expect(output).not.toMatch(/"allow"|"ask"|"defer"|updatedInput|"approve"|"decision"/);
  });
});
