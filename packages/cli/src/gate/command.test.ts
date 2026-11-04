import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { addProject, cleanup, stage } from '../sessions/test-support.js';
import { gateReplay, gateReport } from './command.js';
import { parseRows } from './record.js';
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
    expect(await run(['gate', 'replay', '--allow', 'gate-app'], deps)).toBe(ExitCode.OK);
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
    await run(['--json', 'gate', 'replay', '--allow', 'gate-app'], deps);
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

  it('takes --registry-state, which asks the manager only for a name it can ask about', async () => {
    const staged = stage();
    addProject(staged, 'url-app', 'one', [call('t1', 'npm install git+https://example.com/x/y.git'), answer('t1')]);
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['gate', 'replay', '--allow', 'url-app', '--registry-state'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Registry state read');
  });

  it('refuses a replay that names no folder and has no saved allowlist', async () => {
    const { deps, err } = setup();
    expect(await run(['gate', 'replay'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--allow');
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
