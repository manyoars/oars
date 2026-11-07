import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { addProject, cleanup, stage } from '../sessions/test-support.js';
import { gateInstall, gatePolicy, gateReplay, gateReport } from './command.js';
import { folderKey, parseRows } from './record.js';
import type { RegistryReader } from './registry.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const call = (id: string, command: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const answer = (id: string): string =>
  JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'added 1 package' }] } });

const setup = () => {
  const staged = stage();
  addProject(staged, 'gate-app', 'one', [call('t1', 'npm install left-pad'), answer('t1'), call('t2', 'npx some-tool --help'), answer('t2'), call('t3', 'npm ci')]);
  const h = harness();
  h.deps.sessions = staged.runtime;
  return { ...h, staged };
};

describe('oars gate replay and report', () => {
  it('replays the allowed folder, then reports counts from the file it wrote', async () => {
    const { deps, out, staged } = setup();
    expect(await run(['gate', 'replay', '--allow', 'gate-app', '--no-registry-state'], deps)).toBe(ExitCode.OK);
    const text = out.join('');
    expect(text).toContain('Crossings: 2');
    expect(text).toContain('registry state not read');
    const rows = parseRows(readFileSync(join(staged.storeDir, 'crossings.jsonl'), 'utf8'));
    expect(rows.filter((row) => row.kind === 'crossing')).toHaveLength(2);

    out.length = 0;
    expect(await run(['gate', 'report'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('npm-package install: 1 (1 distinct)');
    expect(out.join('')).toContain('Replay cannot see:');
  });

  it('prints the replay and the report as one JSON document with --json', async () => {
    const { deps, out } = setup();
    await run(['--json', 'gate', 'replay', '--allow', 'gate-app', '--no-registry-state'], deps);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, run: { crossings: 2, registryRead: false } });
    out.length = 0;
    await run(['--json', 'gate', 'report'], deps);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, crossings: 2, registryRead: false });
  });

  it('asks for replay first when there is no file', async () => {
    const { deps, err } = setup();
    expect(await run(['gate', 'report'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('oars gate replay');
  });

  it('reports a store holding only hook rows, with no replay run', async () => {
    const { deps, out, staged } = setup();
    const row = { kind: 'crossing', v: 1, via: 'hook', class: 'npm-package', form: 'install', name: 'left-pad', session: 's', toolUseId: 't', novelty: 'fleet', registryState: 'not-read', origin: 'not-read' };
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(join(staged.storeDir, 'crossings.jsonl'), `${JSON.stringify(row)}\n`);
    expect(await run(['gate', 'report'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('No replay has run');
    expect(out.join('')).toContain('Crossings: 1');
    expect(out.join('')).toContain('Recorded by: hook 1');
  });

  it('says so when the store is not configured', async () => {
    const { deps, err } = setup();
    delete deps.sessions;
    expect(await run(['gate', 'report'], deps)).toBe(ExitCode.UNEXPECTED);
    expect(err.join('')).toContain('not configured');
  });

  it('reads registry state only when handed a reader, and the report then says so', async () => {
    const { deps, out, staged } = setup();
    const reader: RegistryReader = () => Promise.resolve({ state: 'found', created: '2020-01-01T00:00:00.000Z', latest: '1.0.0' });
    const sessionDeps = { sessions: staged.runtime, install: undefined, now: deps.now };
    const outcome = await gateReplay(sessionDeps, { allow: ['gate-app'], registry: reader });
    expect(outcome.text).toContain('Registry state read');
    expect(outcome.text).not.toContain('registry state not read');
    out.length = 0;
    await run(['gate', 'report'], deps);
    expect(out.join('')).not.toContain('registry state not read');
    expect((await gateReport(sessionDeps)).document).toMatchObject({ registryRead: true });
  });

  it('asks the registry by default, only for a name the manager can ask about', async () => {
    const staged = stage();
    addProject(staged, 'url-app', 'one', [call('t1', 'npm install git+https://example.com/x/y.git'), answer('t1')]);
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['gate', 'replay', '--allow', 'url-app'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Registry state read');
  });

  it('replays every folder when none is named and no deposit saved an allowlist', async () => {
    const { deps, out } = setup();
    expect(await run(['gate', 'replay', '--no-registry-state'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Crossings: 2');
  });
});

describe('oars gate policy', () => {
  it('prints the defaults when no file is there, and the file when one fits', async () => {
    const { deps, out, staged } = setup();
    expect(await run(['gate', 'policy'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Policy in force: defaults (no file at');
    expect(out.join('')).toContain('not-found: warn');
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(join(staged.storeDir, 'gate-policy.json'), '{"classes":{"not-found":"block"},"holdbackPercent":25}');
    out.length = 0;
    expect(await run(['gate', 'policy'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('not-found: block');
    expect(out.join('')).toContain('Holdback: 25% of notes are not shown');
  });

  it('prints one JSON document with --json, and says an invalid file was ignored', async () => {
    const { deps, out, staged } = setup();
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(join(staged.storeDir, 'gate-policy.json'), 'not json');
    await run(['--json', 'gate', 'policy'], deps);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, source: 'invalid', policy: { classes: { 'young-name': 'warn', 'not-found': 'warn' }, youngDays: 30, holdbackPercent: 10 } });
  });

  it('says so when the store is not configured', async () => {
    await expect(gatePolicy({ sessions: undefined, install: undefined, now: () => 0 })).rejects.toBeInstanceOf(CliError);
  });
});

describe('oars gate install, at the moment of opting in', () => {
  it('tells the operator what the hook does: records, notes by default, denies only on block, never allows or changes', async () => {
    const staged = stage();
    const userSettings = join(staged.storeDir, '..', 'claude', 'settings.json');
    const install = { nodePath: 'node', hookBin: 'hook-bin.js', userSettings, cwd: tmpdir(), schtasks: () => Promise.resolve({ code: 0, output: '' }) };
    const outcome = await gateInstall({ sessions: staged.runtime, install, now: () => 0 });
    expect(outcome.text).toContain(
      'It records each crossing in crossings.jsonl, adds a note about a young or missing name by default, and denies a call only if you write `block` in gate-policy.json; it never allows or changes a call.',
    );
    expect(outcome.text).not.toContain('prints nothing');
  });
});

describe('the file the command reads', () => {
  it('is a CliError that says to run replay when it is missing or holds no run', async () => {
    const staged = stage();
    const sessionDeps = { sessions: staged.runtime, install: undefined, now: () => 0 };
    await expect(gateReport(sessionDeps)).rejects.toBeInstanceOf(CliError);
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(join(staged.storeDir, 'crossings.jsonl'), 'not json\n');
    await expect(gateReport(sessionDeps)).rejects.toThrow(/oars gate replay/);
  });
});

describe('oars gate hook, through the command', () => {
  const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' }, cwd: tmpdir(), permission_mode: 'default' });

  it('records one row from staged stdin, prints nothing, and exits 0', async () => {
    const { deps, out, staged } = setup();
    staged.stdin.end(payload);
    expect(await run(['gate', 'hook'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toBe('');
    const rows = parseRows(readFileSync(join(staged.storeDir, 'crossings.jsonl'), 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'crossing', via: 'hook', name: 'left-pad', session: 's1', toolUseId: 'u1' });
  });

  it('prints the deny the hook returns, since this path is reached by any extra argument too', async () => {
    const { deps, out, staged } = setup();
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(join(staged.storeDir, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    const now = deps.now();
    const answer = { kind: 'registry', v: 1, day: new Date(now).toISOString().slice(0, 10), ts: new Date(now).toISOString(), folder: folderKey(tmpdir()), class: 'npm-package', state: 'not-found', created: null, name: 'left-pad', latest: null };
    writeFileSync(join(staged.storeDir, 'gate-registry.jsonl'), `${JSON.stringify(answer)}
`);
    staged.stdin.end(payload);
    expect(await run(['gate', 'hook'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('"permissionDecision":"deny"');
  });

  it('writes no crossings.jsonl or gate-index.txt in the working folder when no store is configured', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oars-gate-nostore-'));
    const before = process.cwd();
    process.chdir(work);
    try {
      const { deps, out } = harness();
      delete deps.sessions;
      expect(await run(['gate', 'hook'], deps)).toBe(ExitCode.OK);
      expect(out.join('')).toBe('');
      expect(existsSync(join(work, 'crossings.jsonl'))).toBe(false);
      expect(existsSync(join(work, 'gate-index.txt'))).toBe(false);
    } finally {
      process.chdir(before);
      rmSync(work, { recursive: true, force: true });
    }
  });
});
