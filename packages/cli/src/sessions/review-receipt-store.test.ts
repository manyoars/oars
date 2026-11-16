// `oars sessions receipt` against a real store: a fixture transcript is deposited into a store under a temp APPDATA and the command reads it back, with no `loadStore` mock. Every literal is invented.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { ExitCode } from '../errors.js';
import { markNoticeShown } from '../telemetry/consent.js';
import { harness } from '../test-support.js';
import { deposit } from './store.js';
import { addProject, cleanup, NOW, stage, type Staged } from './test-support.js';

const stamp = (second: number): string => `2026-06-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const line = (value: object): string => JSON.stringify(value);
const user = (second: number, content: unknown): string => line({ type: 'user', uuid: `u${String(second)}`, timestamp: stamp(second), cwd: '/w', message: { role: 'user', content } });
const bash = (second: number, id: string, command: string, side = false): string =>
  line({ type: 'assistant', uuid: `a${String(second)}`, timestamp: stamp(second), cwd: '/w', ...(side ? { isSidechain: true } : {}), message: { role: 'assistant', model: 'claude-opus-x', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } } });
const result = (second: number, id: string, failed: boolean): string => user(second, [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? 'Exit code 1\nboom' : 'fine' }]);

let staged: Staged;
let appdata: string;
beforeEach(async () => {
  appdata = mkdtempSync(join(tmpdir(), 'oars-receipt-appdata-'));
  staged = stage();
  addProject(staged, 'proj', 'rcpt-1', [
    user(1, 'please check the build'),
    bash(2, 't1', 'git status'),
    result(3, 't1', false),
    bash(4, 't2', 'npm run build'),
    result(5, 't2', true),
    bash(6, 't3', 'npx vitest run src/secret-feature.test.ts'),
    result(7, 't3', false),
    bash(8, 't4', 'npm test && git push'),
    result(9, 't4', false),
    bash(10, 't5', 'just check'),
    result(11, 't5', false),
  ]);
  await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
});
afterEach(() => {
  cleanup();
  rmSync(appdata, { recursive: true, force: true });
});

const wired = (): ReturnType<typeof harness> => {
  const h = harness({ APPDATA: appdata, XDG_CONFIG_HOME: appdata });
  // The settings folder the CLI resolves is the temp one, and the store sits under a temp folder too: confirmed before anything runs.
  expect(defaultConfigDir({ APPDATA: appdata, XDG_CONFIG_HOME: appdata }, process.platform, '/nowhere')).toBe(appdata);
  expect(isAbsolute(staged.storeDir) && !relative(tmpdir(), staged.storeDir).startsWith('..')).toBe(true);
  h.deps.sessions = { ...staged.runtime, stdout: { write: () => true } };
  return h;
};

describe('oars sessions receipt on a real store', () => {
  it('lists what capture really stored: npm scripts, npx wrappers, and just recipes, with their results', async () => {
    const h = wired();
    expect(await run(['sessions', 'receipt', 'rcpt-1'], h.deps)).toBe(ExitCode.OK);
    const out = h.out.join('');
    expect(out).toContain('| `npm run build` | exit 1 | 2 |');
    expect(out).toContain('| `npx vitest run` | exit 0 | 3 |');
    expect(out).toContain('| `npm test` | exit 0 | 4 |');
    expect(out).toContain('| `just check` | exit 0 | 5 |');
    // `git status` and `git push` are counted, not listed.
    expect(out).toContain('2 other commands not shown.');
    expect(out).not.toContain('secret-feature');
    expect(out).not.toContain('please check');
  });

  it('prints the model the store holds on the calls when the session names none', async () => {
    const h = wired();
    await run(['sessions', 'receipt', 'rcpt-1'], h.deps);
    expect(h.out.join('')).toContain('- Model: claude-opus-x');
  });

  it('prints no home path or prompt text', async () => {
    const h = wired();
    await run(['sessions', 'receipt', 'rcpt-1'], h.deps);
    expect(h.out.join('')).not.toContain(staged.root);
  });

  it('starts no daily telemetry send, even with telemetry on, the notice shown, and a send due', async () => {
    const spawned: string[] = [];
    const h = wired();
    expect(markNoticeShown(appdata, () => 0)).toBe(true);
    const telemetry = { dir: appdata, platform: 'linux' as const, spawnSend: (target: string) => spawned.push(target) };
    h.deps.telemetry = telemetry;
    expect(await run(['sessions', 'receipt', 'rcpt-1'], h.deps)).toBe(ExitCode.OK);
    expect(spawned).toEqual([]);
    // The same setup starts a send for another command, so the empty list above is the command's doing and not the setup's.
    expect(await run(['telemetry', 'status'], { ...h.deps, telemetry })).toBe(ExitCode.OK);
    expect(spawned).toEqual([appdata]);
  });

  it('starts no daily telemetry send when the id is unknown and the run throws', async () => {
    const spawned: string[] = [];
    const h = wired();
    expect(markNoticeShown(appdata, () => 0)).toBe(true);
    h.deps.telemetry = { dir: appdata, platform: 'linux', spawnSend: (target: string) => spawned.push(target) };
    expect(await run(['sessions', 'receipt', 'no-such-session'], h.deps)).not.toBe(ExitCode.OK);
    expect(spawned).toEqual([]);
  });

  it('leaves a sidechain verification call out of the table and the call count', async () => {
    addProject(staged, 'proj', 'rcpt-2', [user(1, 'go'), bash(2, 's1', 'npm run lint'), result(3, 's1', false), bash(4, 's2', 'tsc --noEmit', true), result(5, 's2', false)]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const h = wired();
    expect(await run(['sessions', 'receipt', 'rcpt-2'], h.deps)).toBe(ExitCode.OK);
    const out = h.out.join('');
    expect(out).toContain('| `npm run lint` | exit 0 | 1 |');
    expect(out).not.toContain('tsc');
    expect(out).toContain('(1 in all)');
  });
});
