import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { parseRows, type CrossingRecord, type RegistryRow, type RunRow } from './record.js';
import { replay } from './replay.js';
import type { RegistryAnswer, RegistryReader } from './registry.js';

const REPO = 'C--work-app';
const WORKTREE = `${REPO}--claude-worktrees-one`;
const OTHER_REPO = 'C--work-tool';
const OFF_LIST = 'C--work-private';

let root: string;
let storeDir: string;
let projectsRoot: string;
const NOW = Date.parse('2026-11-04T00:00:00Z');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oars-gate-'));
  storeDir = join(root, 'store');
  projectsRoot = join(root, 'projects');
  await mkdir(storeDir, { recursive: true });
  await mkdir(projectsRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const stamp = (minute: number): string => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const typed = (minute: number, text: string, extra: object = {}): object => ({ type: 'user', timestamp: stamp(minute), permissionMode: 'default', message: { role: 'user', content: text }, ...extra });

const use = (minute: number, id: string, name: string, input: object, extra: object = {}): object => ({
  type: 'assistant',
  timestamp: stamp(minute),
  cwd: join(root, 'cwd'),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  ...extra,
});

const bash = (minute: number, id: string, command: string, extra: object = {}): object => use(minute, id, 'Bash', { command }, extra);

const result = (minute: number, id: string, text: string, failed = false): object => ({
  type: 'user',
  timestamp: stamp(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: text }] },
});

const writeLog = async (base: string, project: string, path: string, lines: readonly (object | string)[]): Promise<void> => {
  const file = join(base, project, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
};

const run = (allow: string[], registry?: RegistryReader) => replay({ storeDir, projectsRoot }, { allow, now: () => NOW, ...(registry === undefined ? {} : { registry }) });

const written = async (): Promise<{ run: RunRow; crossings: CrossingRecord[]; registry: RegistryRow[] }> => {
  const rows = parseRows(await readFile(join(storeDir, 'crossings.jsonl'), 'utf8'));
  const head = rows.find((row): row is RunRow => row.kind === 'run');
  if (head === undefined) throw new Error('no run row');
  return { run: head, crossings: rows.filter((row): row is CrossingRecord => row.kind === 'crossing'), registry: rows.filter((row): row is RegistryRow => row.kind === 'registry') };
};

const named = (rows: readonly CrossingRecord[], name: string): CrossingRecord => {
  const row = rows.find((one) => one.name === name);
  if (row === undefined) throw new Error(`no crossing named ${name}`);
  return row;
};

/** Every file under a folder with its size and mtime, so a test can say what a run changed. */
const snapshot = async (folder: string): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const held = await stat(path);
        found.set(relative(folder, path), `${String(held.size)}:${String(held.mtimeMs)}`);
      }
    }
  };
  await walk(folder);
  return found;
};

describe('the source of a replay', () => {
  it('reads the raw transcripts of allowed folders only, from the harness and the archive, one copy of each', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install on-disk'), result(2, 't1', 'added')]);
    await writeLog(join(storeDir, 'raw'), REPO, 'a.jsonl', [bash(1, 't1', 'npm install on-disk'), result(2, 't1', 'added')]);
    await writeLog(join(storeDir, 'raw'), REPO, 'gone.jsonl', [bash(3, 't2', 'npm install archived'), result(4, 't2', 'added')]);
    await writeLog(projectsRoot, OFF_LIST, 'p.jsonl', [bash(5, 't3', 'npm install off-list')]);
    await writeLog(join(storeDir, 'raw'), 'cursor', 'c.jsonl', [bash(6, 't4', 'npm install from-cursor')]);

    const done = await run([`${REPO}*`, 'cursor']);
    const { crossings } = await written();

    expect(crossings.map((row) => row.name).sort()).toEqual(['archived', 'on-disk']);
    expect(done.run.transcripts).toBe(2);
  });

  it('falls back to the saved allowlist and masks with the saved domains', async () => {
    await writeFile(join(storeDir, 'state.json'), JSON.stringify({ files: {}, redactDomains: ['corp.example'], allow: [REPO] }));
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install git+https://corp.example/x/y.git')]);
    await run([]);
    const [row] = (await written()).crossings;
    expect(row?.name).not.toContain('corp.example');
  });

  it('refuses to read anything when no folder is named', async () => {
    await expect(run([])).rejects.toBeInstanceOf(CliError);
  });

  it('writes nothing outside crossings.jsonl and leaves no temp file', async () => {
    await writeFile(join(storeDir, 'state.json'), JSON.stringify({ files: {}, redactDomains: [], allow: [REPO] }));
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install one')]);
    const before = await snapshot(root);
    await run([]);
    const after = await snapshot(root);
    const crossingFile = join('store', 'crossings.jsonl');
    expect(after.has(crossingFile)).toBe(true);
    after.delete(crossingFile);
    expect(after).toEqual(before);
  });

  it('counts a torn line and an unreadable transcript instead of failing the run', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', ['{not json', bash(1, 't1', 'npm install one')]);
    await mkdir(join(projectsRoot, REPO, 'folder.jsonl'), { recursive: true });
    await writeLog(projectsRoot, REPO, 'b.jsonl', [bash(2, 't2', 'npm install two')]);
    const { run: head } = await run([REPO]);
    expect(head.badLines).toBe(1);
    expect((await written()).crossings).toHaveLength(2);
  });

  it('does not read an api-request-blob line, a copy of the request body', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [{ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm install blob' } }] } }]);
    await run([REPO]);
    expect((await written()).crossings).toHaveLength(0);
  });

  it('names no registry state and contacts nothing without the option', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install one')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const done = await run([REPO]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const [row] = (await written()).crossings;
    expect(row).toMatchObject({ registryState: 'not-read', registryAge: 'not-read', againstLatest: 'not-read' });
    expect(done.run.registryRead).toBe(false);
    expect(done.text).toContain('registry state not read');
  });
});

describe('a crossing record', () => {
  it('holds one record per crossing with its vocabulary, and arm and line shown read none', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [typed(0, 'set this up'), bash(1, 't1', 'npm install left@1.2.3 right'), result(2, 't1', 'added'), use(3, 't2', 'mcp__server-one__search', {}), result(4, 't2', 'ok'), use(5, 't3', 'Skill', { skill: 'a-skill' }), result(6, 't3', 'ok')]);
    await run([REPO]);
    const { crossings } = await written();
    expect(crossings).toHaveLength(4);
    expect(named(crossings, 'left')).toMatchObject({ kind: 'crossing', v: 1, day: '2026-10-01', class: 'npm-package', form: 'install', program: 'npm', version: '1.2.3', versionForm: 'pinned', status: 'ok', statusReports: true, arm: 'none', lineShown: 'none', session: 'a', agent: null, toolUseId: 't1', ts: stamp(1) });
    expect(named(crossings, 'server-one')).toMatchObject({ class: 'mcp-server', form: 'mcp-call', program: 'mcp' });
    expect(named(crossings, 'a-skill')).toMatchObject({ class: 'skill', form: 'skill-call', program: 'skill' });
  });

  it('keeps no path, cwd, or command text', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'cd /secret/place && npm install one --prefix /secret/other')]);
    await run([REPO]);
    const text = await readFile(join(storeDir, 'crossings.jsonl'), 'utf8');
    expect(text).not.toContain('secret');
    expect(text).not.toContain(REPO);
    expect(text).not.toContain(root.replaceAll('\\', '\\\\'));
  });

  it('writes one record when a resumed transcript replays a call', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install one'), result(2, 't1', 'added')]);
    await writeLog(projectsRoot, REPO, 'b.jsonl', [bash(1, 't1', 'npm install one'), result(2, 't1', 'added'), bash(3, 't2', 'npm install two')]);
    await run([REPO]);
    expect((await written()).crossings.map((row) => row.name)).toEqual(['one', 'two']);
  });

  it.each([
    ['prompt', typed(0, 'please add handy-lib to this'), 'prompt'],
    ['a file read', result(0, 'r1', 'the docs say to use handy-lib here'), 'repo-file'],
    ['a web fetch', result(0, 'w1', 'handy-lib is popular'), 'web'],
    ['a shell result', result(0, 's1', 'try handy-lib'), 'tool-output'],
    ['a skill body', typed(0, 'Install handy-lib first', { isMeta: true }), 'skill'],
    ['an injected reminder', typed(0, '<system-reminder>handy-lib is listed</system-reminder>'), 'harness'],
    ['an attachment', { type: 'attachment', timestamp: stamp(0), attachment: { type: 'listing', content: 'handy-lib' } }, 'harness'],
  ])('reads where the name came from: %s', async (_label, line, origin) => {
    const calls = [use(0, 'r1', 'Read', { file_path: 'x' }), use(0, 'w1', 'WebFetch', { url: 'x' }), bash(0, 's1', 'ls')];
    await writeLog(projectsRoot, REPO, 'a.jsonl', [...calls, line, bash(1, 't1', 'npm install handy-lib'), result(2, 't1', 'handy-lib added')]);
    await run([REPO]);
    expect(named((await written()).crossings, 'handy-lib').origin).toBe(origin);
  });

  it('reads none-seen when the name appears only after the call, inside a longer word, or in the agent\'s own text', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [
      typed(0, 'look at handy-lib-extra and other/handy-lib'),
      { type: 'assistant', timestamp: stamp(0), message: { role: 'assistant', content: [{ type: 'text', text: 'I will use handy-lib' }] } },
      bash(1, 't1', 'npm install handy-lib'),
      result(2, 't1', 'handy-lib added'),
      bash(3, 't2', 'npm install handy-lib'),
    ]);
    await run([REPO]);
    const { crossings } = await written();
    expect(crossings.map((row) => row.origin)).toEqual(['none-seen', 'none-seen']);
  });

  it('matches a Python name by the spellings the installer treats as one', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [typed(0, 'add Some_Package'), bash(1, 't1', 'pip install some-package')]);
    await run([REPO]);
    expect(named((await written()).crossings, 'some-package').origin).toBe('prompt');
  });

  it('assigns novelty across session, repository, and fleet, in time order and with worktrees folded', async () => {
    await writeLog(projectsRoot, REPO, 'first.jsonl', [bash(1, 't1', 'npm install one'), bash(2, 't2', 'npm install one')]);
    await writeLog(projectsRoot, WORKTREE, 'second.jsonl', [bash(3, 't3', 'npm install one')]);
    await writeLog(projectsRoot, OTHER_REPO, 'third.jsonl', [bash(4, 't4', 'npm install one')]);
    await run([`${REPO}*`, OTHER_REPO]);
    const { crossings } = await written();
    expect(crossings.map((row) => row.novelty)).toEqual(['fleet', 'none', 'session', 'repository']);
  });

  it('treats a subagent as the session of its parent and marks its depth', async () => {
    await writeLog(projectsRoot, REPO, 'main.jsonl', [bash(1, 't1', 'npm install one')]);
    await writeLog(projectsRoot, REPO, 'main/subagents/agent-x.jsonl', [typed(1, 'install another-lib'), bash(2, 't2', 'npm install one'), bash(3, 't3', 'npm install another-lib')]);
    await writeLog(projectsRoot, REPO, 'main/subagents/workflows/wf_1/agent-y.jsonl', [bash(4, 't4', 'npm install third')]);
    await run([REPO]);
    const { crossings } = await written();
    expect(crossings[0]).toMatchObject({ depth: 'main', agent: null, session: 'main' });
    expect(crossings[1]).toMatchObject({ depth: 'subagent', agent: 'agent-x', session: 'main', novelty: 'none' });
    expect(named(crossings, 'another-lib')).toMatchObject({ origin: 'prompt', decidedBy: 'agent' });
    expect(named(crossings, 'third')).toMatchObject({ depth: 'subagent', agent: 'agent-y' });
  });

  it('reads who decided and the permission mode in force', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [
      typed(0, 'add asked-lib', { permissionMode: 'bypassPermissions' }),
      bash(1, 't1', 'npm install asked-lib'),
      bash(2, 't2', 'npm install own-pick'),
      { type: 'permission-mode', permissionMode: 'somethingNew' },
      bash(3, 't3', 'npm install later-pick'),
    ]);
    await writeLog(projectsRoot, REPO, 'b.jsonl', [bash(4, 't4', 'npm install no-mode')]);
    await run([REPO]);
    const { crossings } = await written();
    expect(named(crossings, 'asked-lib')).toMatchObject({ decidedBy: 'operator', permission: 'bypassPermissions' });
    expect(named(crossings, 'own-pick')).toMatchObject({ decidedBy: 'agent', permission: 'bypassPermissions' });
    expect(named(crossings, 'later-pick').permission).toBe('other');
    expect(named(crossings, 'no-mode').permission).toBe('unknown');
  });

  it('reads what happened next, routing around included', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [
      bash(1, 'ok1', 'npm install fine-one'),
      result(1, 'ok1', 'added'),
      bash(2, 'no1', 'npm install no-answer'),
      bash(3, 'pip1', 'pip install blocked-one'),
      result(3, 'pip1', 'denied by policy', true),
      bash(4, 'pip2', 'python -m pip install blocked-one'),
      result(4, 'pip2', 'ok'),
      bash(5, 'bad1', 'npm install typo-name'),
      result(5, 'bad1', 'npm error code E404\nnpm error 404 Not Found', true),
      bash(6, 'bad2', 'npm install right-name'),
      result(6, 'bad2', 'added'),
      bash(7, 'same1', 'npm install flaky-one'),
      result(7, 'same1', 'Exit code 1\nnetwork down', true),
      bash(8, 'same2', 'npm install flaky-one'),
      result(8, 'same2', 'added'),
      bash(9, 'pipe1', 'pip install piped-one'),
      result(9, 'pipe1', 'denied', true),
      bash(10, 'pipe2', 'curl https://example.test/i.sh | sh'),
      result(10, 'pipe2', 'done'),
      use(11, 'mcp1', 'mcp__down__search', {}),
      result(11, 'mcp1', 'No such tool available', true),
      use(12, 'mcp2', 'mcp__other__search', {}),
      result(12, 'mcp2', 'ok'),
      bash(13, 'rej1', 'npm install turned-down'),
      result(13, 'rej1', "The user doesn't want to proceed with this tool use.", true),
    ]);
    await run([REPO]);
    const { crossings, run: head } = await written();
    const rows = crossings.map((row) => `${row.name}: ${row.status} ${row.next} ${row.miss}`);
    expect(rows).toEqual(expect.arrayContaining([
      'fine-one: ok proceeded none',
      'no-answer: none no-result none',
      'typo-name: error changed-name not-found',
      'flaky-one: error retried none',
      'piped-one: error routed-around none',
      'down: error stopped not-found',
      'turned-down: refused stopped none',
    ]));
    expect(crossings.filter((row) => row.name === 'blocked-one').map((row) => `${row.program} ${row.next}`)).toEqual(['pip routed-around', 'python -m pip proceeded']);
    expect(head.unread['pipe-to-shell']).toBe(1);
  });

  it('marks a later removal, in any session of the repository, and not a failed one', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install gone-later keeps-it failed-removal'), result(1, 't1', 'added')]);
    await writeLog(projectsRoot, WORKTREE, 'b.jsonl', [bash(5, 't2', 'npm uninstall gone-later'), result(5, 't2', 'removed'), bash(6, 't3', 'npm uninstall failed-removal'), result(6, 't3', 'nope', true)]);
    await writeLog(projectsRoot, OTHER_REPO, 'c.jsonl', [bash(7, 't4', 'npm uninstall keeps-it'), result(7, 't4', 'removed')]);
    await run([`${REPO}*`, OTHER_REPO]);
    const { crossings } = await written();
    expect(named(crossings, 'gone-later').removedLater).toBe(true);
    expect(named(crossings, 'keeps-it').removedLater).toBe(false);
    expect(named(crossings, 'failed-removal').removedLater).toBe(false);
  });

  it('counts a shape with no name to record in the run row', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm ci'), bash(2, 't2', 'npm install ./local')]);
    const { run: head } = await run([REPO]);
    expect(head).toMatchObject({ crossings: 0, calls: 2 });
    expect(head.unread).toMatchObject({ 'manifest-install': 1, 'local-path': 1 });
  });
});

describe('the registry option', () => {
  const answering = (answer: Partial<RegistryAnswer> = {}) => vi.fn<RegistryReader>(async () => Promise.resolve({ state: 'found', latest: '2.0.0', created: '2026-09-28T00:00:00.000Z', ...answer }));

  it('asks once per name, in the working folder of the call, and reads version and age against the answer', async () => {
    await mkdir(join(root, 'cwd'));
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install one@2.0.0'), bash(2, 't2', 'npm install one@1.0.0'), bash(3, 't3', 'npm install one@^1.0.0'), bash(4, 't4', 'npm install one'), bash(5, 't5', 'npm install one@latest')]);
    const reader = answering();
    const done = await run([REPO], reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({ class: 'npm-package', name: 'one', cwd: join(root, 'cwd') });
    const { crossings, registry } = await written();
    expect(crossings.map((row) => row.againstLatest)).toEqual(['latest', 'not-latest', 'range', 'unstated', 'latest']);
    expect(crossings[0]).toMatchObject({ registryState: 'found', registryAge: 'under-7-days' });
    expect(registry).toEqual([expect.objectContaining({ kind: 'registry', class: 'npm-package', name: 'one', state: 'found', latest: '2.0.0', day: '2026-11-04' })]);
    expect(done.run.registryRead).toBe(true);
    expect(done.text).not.toContain('registry state not read');
  });

  it.each([
    ['2026-10-30T00:00:00.000Z', 'after-crossing'],
    ['2026-09-10T00:00:00.000Z', 'under-30-days'],
    ['2026-01-01T00:00:00.000Z', 'under-1-year'],
    ['2020-01-01T00:00:00.000Z', 'older'],
    [null, 'unknown'],
  ])('buckets a name created at %s as %s', async (created, age) => {
    await mkdir(join(root, 'cwd'));
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install one')]);
    await run([REPO], answering({ created }));
    expect((await written()).crossings[0]?.registryAge).toBe(age);
  });

  it('reuses the answers kept in crossings.jsonl, across a replay without the option too', async () => {
    await mkdir(join(root, 'cwd'));
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install one')]);
    await run([REPO], answering());
    await run([REPO]);
    expect((await written()).registry).toHaveLength(1);
    expect((await written()).crossings[0]?.registryState).toBe('not-read');
    const second = answering();
    await run([REPO], second);
    expect(second).not.toHaveBeenCalled();
    expect((await written()).crossings[0]?.registryState).toBe('found');
  });

  it('asks nothing for a URL, an MCP server, a skill, or a folder that is gone, and says not-read rather than guess', async () => {
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install gone-folder'), bash(2, 't2', 'npm install git+https://example.test/a/b.git', { cwd: root }), use(3, 't3', 'mcp__one__x', {}, { cwd: root }), use(4, 't4', 'Skill', { skill: 'x' }, { cwd: root })]);
    const reader = answering();
    await run([REPO], reader);
    expect(reader).not.toHaveBeenCalled();
    expect(new Set((await written()).crossings.map((row) => row.registryState))).toEqual(new Set(['not-read']));
  });

  it('keeps not-found and unreachable apart, and a failed read stays out of the cache', async () => {
    await mkdir(join(root, 'cwd'));
    await writeLog(projectsRoot, REPO, 'a.jsonl', [bash(1, 't1', 'npm install absent'), bash(2, 't2', 'npm install dark'), bash(3, 't3', 'npm install thrown')]);
    const reader = vi.fn<RegistryReader>(async ({ name }) => {
      if (name === 'thrown') throw new Error('boom');
      return Promise.resolve({ state: name === 'absent' ? 'not-found' : 'unreachable', latest: null, created: null });
    });
    await run([REPO], reader);
    const { crossings, registry } = await written();
    expect(crossings.map((row) => row.registryState)).toEqual(['not-found', 'unreachable', 'unreachable']);
    expect(crossings[0]?.againstLatest).toBe('unknown');
    expect(registry.map((row) => row.name)).toEqual(['absent']);
  });
});
