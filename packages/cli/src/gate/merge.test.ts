import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slugOf } from '../sessions/allow.js';
import { gateHook } from './hook.js';
import { loadIndex } from './novelty.js';
import { crossingsOf, GATE_VERSION, liveCrossings, mergeCrossings, parseRows, type CrossingRecord, type Row, type RunRow } from './record.js';
import { formatReport, reportOf } from './report.js';
import { replay } from './replay.js';

const crossing = (extra: Partial<CrossingRecord> = {}): CrossingRecord => ({
  kind: 'crossing',
  v: GATE_VERSION,
  via: 'replay',
  day: '2026-10-01',
  class: 'npm-package',
  form: 'install',
  program: 'npm',
  versionForm: 'unstated',
  statusReports: true,
  origin: 'prompt',
  novelty: 'fleet',
  decidedBy: 'operator',
  permission: 'default',
  status: 'ok',
  next: 'proceeded',
  removedLater: false,
  depth: 'main',
  miss: 'none',
  againstLatest: 'not-read',
  registryState: 'not-read',
  registryAge: 'not-read',
  arm: 'none',
  lineShown: 'none',
  lineHeld: 'none',
  session: 's1',
  agent: null,
  toolUseId: 't1',
  ts: '2026-10-01T10:00:00.000Z',
  name: 'alpha',
  version: null,
  ...extra,
});

/** What the hook writes: the keys, the time, the registry, novelty; every transcript field `not-read`. */
const hookRow = (extra: Partial<CrossingRecord> = {}): CrossingRecord =>
  crossing({
    via: 'hook',
    origin: 'not-read',
    decidedBy: 'not-read',
    status: 'not-read',
    next: 'not-read',
    removedLater: 'not-read',
    miss: 'not-read',
    ts: '2026-10-01T10:00:00.500Z',
    ...extra,
  });

const run = (extra: Partial<RunRow> = {}): RunRow => ({ kind: 'run', v: GATE_VERSION, day: '2026-11-04', transcripts: 2, unreadable: 0, badLines: 0, calls: 9, crossings: 0, unread: {}, registryRead: false, ...extra });

describe('one row per crossing', () => {
  it("keeps the hook's time-of-crossing fields and fills the rest from the replay", () => {
    const [one, ...rest] = mergeCrossings(
      [crossing({ permission: 'plan', novelty: 'none', registryState: 'not-read', ts: '2026-10-01T10:00:09.000Z' })],
      [hookRow({ permission: 'default', novelty: 'repository', registryState: 'found', againstLatest: 'latest', registryAge: 'older' })],
    );
    expect(rest).toEqual([]);
    expect(one).toMatchObject({ via: 'both', permission: 'default', novelty: 'repository', registryState: 'found', againstLatest: 'latest', registryAge: 'older', ts: '2026-10-01T10:00:00.500Z' });
    expect(one).toMatchObject({ origin: 'prompt', decidedBy: 'operator', status: 'ok', next: 'proceeded', removedLater: false, miss: 'none' });
  });

  it('keeps the policy the hook wrote under, which a replay row never carries', () => {
    const [one] = mergeCrossings([crossing()], [hookRow({ policy: 'invalid' })]);
    expect(one).toMatchObject({ via: 'both', policy: 'invalid' });
    expect(mergeCrossings([crossing()], [hookRow()])[0]).not.toHaveProperty('policy');
  });

  it('reads a hook row from an earlier build, which has no lineHeld, as the replay says', () => {
    const early: Partial<CrossingRecord> = { lineHeld: undefined };
    expect(mergeCrossings([crossing()], [hookRow(early)])[0]).toMatchObject({ lineHeld: 'none' });
    expect(mergeCrossings([crossing()], [hookRow({ lineHeld: 'young-name-note' })])[0]).toMatchObject({ lineHeld: 'young-name-note' });
  });

  it("falls back to the replay's value where the hook read nothing", () => {
    const [one] = mergeCrossings([crossing({ permission: 'plan', novelty: 'session' })], [hookRow({ permission: 'unknown', novelty: 'not-read' })]);
    expect(one).toMatchObject({ permission: 'plan', novelty: 'session', via: 'both' });
  });

  it("keeps the hook's reading of the folder, whichever way the folder changed since", () => {
    // The bin was there at the crossing and is gone at the replay: the hook's read stands.
    const [ran] = mergeCrossings([crossing({ form: 'fetch-and-run' })], [hookRow({ form: 'local-bin-run' })]);
    expect(ran).toMatchObject({ via: 'both', form: 'local-bin-run' });
    // The bin was absent at the crossing and installed since: still a fetch.
    const [fetched] = mergeCrossings([crossing({ form: 'local-bin-run' })], [hookRow({ form: 'fetch-and-run' })]);
    expect(fetched).toMatchObject({ via: 'both', form: 'fetch-and-run' });
  });

  it('takes the three registry fields from one reading, so a mixed row cannot occur', () => {
    // The hook asked and could not reach the registry; a later replay with --registry-state did reach it.
    const hooked = hookRow({ registryState: 'unreachable', againstLatest: 'unknown', registryAge: 'unknown' });
    const replayed = crossing({ registryState: 'found', againstLatest: 'not-latest', registryAge: 'under-7-days' });
    const [one] = mergeCrossings([replayed], [hooked]);
    expect(one).toMatchObject({ registryState: 'unreachable', againstLatest: 'unknown', registryAge: 'unknown' });
    // The hook read nothing: all three come from the replay.
    const [filled] = mergeCrossings([replayed], [hookRow()]);
    expect(filled).toMatchObject({ registryState: 'found', againstLatest: 'not-latest', registryAge: 'under-7-days' });
    // An answer with a field the registry cannot state (no date) still keeps its own reading whole.
    const [partial] = mergeCrossings([replayed], [hookRow({ registryState: 'found', againstLatest: 'latest', registryAge: 'unknown' })]);
    expect(partial).toMatchObject({ registryState: 'found', againstLatest: 'latest', registryAge: 'unknown' });
  });

  it('keeps a local bin run unasked, even when the replay saw no bin and asked the registry', () => {
    // The hook saw the bin and asked nothing; a later replay, with the bin gone, read a fetch and asked. The row says what the hook read, so it was never asked of the registry.
    const replayed = crossing({ form: 'fetch-and-run', registryState: 'found', againstLatest: 'not-latest', registryAge: 'under-7-days' });
    const [one] = mergeCrossings([replayed], [hookRow({ form: 'local-bin-run' })]);
    expect(one).toMatchObject({ form: 'local-bin-run', registryState: 'not-read', againstLatest: 'not-read', registryAge: 'not-read' });
    // A fetch the hook read keeps taking the replay's reading when the hook asked nothing.
    const [fetched] = mergeCrossings([replayed], [hookRow({ form: 'fetch-and-run' })]);
    expect(fetched).toMatchObject({ form: 'fetch-and-run', registryState: 'found' });
  });

  it('leaves a second replay refreshing the transcript fields only', () => {
    const first = mergeCrossings([crossing({ origin: 'web' })], [hookRow({ registryState: 'found' })]);
    const second = mergeCrossings([crossing({ origin: 'prompt', registryState: 'not-read' })], first);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ via: 'both', origin: 'prompt', registryState: 'found' });
  });

  it('keeps rows that pair with nothing, and a row with no tool use id', () => {
    const merged = mergeCrossings(
      [crossing({ toolUseId: 't1' }), crossing({ toolUseId: null, name: 'beta' })],
      [hookRow({ toolUseId: 't9', name: 'gamma' }), hookRow({ toolUseId: null, name: 'beta' })],
    );
    expect(merged.map((row) => `${row.name}:${row.via ?? ''}`)).toEqual(['alpha:replay', 'beta:replay', 'gamma:hook', 'beta:hook']);
  });

  it('counts the same name once per call, whether a source wrote it twice or two sources saw it', () => {
    expect(mergeCrossings([crossing(), crossing()], [hookRow(), hookRow()])).toHaveLength(1);
    expect(mergeCrossings([], [hookRow(), hookRow()])).toHaveLength(1);
    expect(mergeCrossings([crossing(), crossing()], [])).toHaveLength(1);
  });

  it('does not pair across sessions, classes, or names', () => {
    const merged = mergeCrossings([crossing()], [hookRow({ session: 's2' }), hookRow({ class: 'python-package' }), hookRow({ name: 'beta' })]);
    expect(merged).toHaveLength(4);
  });

  it('takes the live rows of a file, and counts a file once however it was written', () => {
    const rows: Row[] = [run(), hookRow(), crossing(), crossing({ via: undefined, toolUseId: 't2', name: 'beta' })];
    expect(liveCrossings(rows)).toHaveLength(1);
    expect(crossingsOf(rows)).toHaveLength(2);
  });
});

describe('oars gate report over both kinds of row', () => {
  const rows: Row[] = [
    run({ crossings: 3 }),
    // Overlap: the hook saw t1 and t2, a replay read both of them, and t3 only the replay read.
    hookRow({ toolUseId: 't1', name: 'alpha', novelty: 'fleet' }),
    hookRow({ toolUseId: 't2', name: 'beta', novelty: 'none', registryState: 'found', againstLatest: 'latest', registryAge: 'older' }),
    crossing({ toolUseId: 't1', name: 'alpha', novelty: 'none', origin: 'prompt' }),
    crossing({ toolUseId: 't2', name: 'beta', novelty: 'fleet', origin: 'web', status: 'error', next: 'stopped' }),
    crossing({ toolUseId: 't3', name: 'gamma', class: 'python-package', form: 'fetch-and-run', program: 'uvx', origin: 'none-seen' }),
    // Hook-only: no replay has read this call yet.
    hookRow({ toolUseId: 't4', name: 'delta', session: 's2' }),
    hookRow({ toolUseId: 't5', name: 'srv', class: 'mcp-server', form: 'mcp-call', program: 'mcp', session: 's2' }),
    // A hook row a retry wrote twice.
    hookRow({ toolUseId: 't4', name: 'delta', session: 's2' }),
  ];
  const report = reportOf(rows);
  const count = (tally: readonly { value: string; count: number }[], value: string): number | undefined => tally.find((one) => one.value === value)?.count;

  it('counts each crossing once, with exact counts by who recorded it', () => {
    // t1 and t2 (hook and replay), t3 (replay only), t4 and t5 (hook only); the retried t4 is the same crossing.
    expect(report.crossings).toBe(5);
    expect(report.via.map((one) => `${one.value} ${String(one.count)}`)).toEqual(['hook 2', 'replay 1', 'both 2']);
    expect(report.classes).toContainEqual({ class: 'npm-package', form: 'install', count: 3, distinct: 3 });
    expect(report.classes).toContainEqual({ class: 'python-package', form: 'fetch-and-run', count: 1, distinct: 1 });
    expect(report.classes).toContainEqual({ class: 'mcp-server', form: 'mcp-call', count: 1, distinct: 1 });
  });

  it("counts the hook's novelty and registry state where it has them, and the replay's origin where the hook has none", () => {
    expect(count(report.novelty, 'fleet')).toBe(4);
    expect(count(report.novelty, 'none')).toBe(1);
    expect(count(report.origin, 'prompt')).toBe(1);
    expect(count(report.origin, 'web')).toBe(1);
    expect(count(report.origin, 'none-seen')).toBe(1);
    expect(count(report.origin, 'not-read')).toBe(2);
    expect(count(report.registryState, 'found')).toBe(1);
    expect(count(report.status, 'error')).toBe(1);
    expect(report.replayed).toBe(true);
    expect(report.registryRead).toBe(true);
  });

  it('says who recorded the rows, and says so when no replay has run', () => {
    expect(formatReport(report)).toContain('Recorded by: hook 2, replay 1, both 2');
    const live = reportOf([hookRow(), hookRow({ toolUseId: 't2', name: 'beta' })]);
    const text = formatReport(live);
    expect(live.replayed).toBe(false);
    expect(text).toContain('No replay has run');
    expect(text).toContain('Crossings: 2');
    expect(text).not.toContain('Read 0 transcripts');
    expect(text).toContain('registry state not read');
  });

  it('uses no evaluative word in anything it prints', () => {
    const text = formatReport(report) + formatReport(reportOf([hookRow()])) + JSON.stringify(report);
    expect(text).not.toMatch(/malicious|threat|attack|danger|unsafe|suspicious|risk|vulnerab|safe|\bbad\b|evil|hostile/i);
  });
});

describe('replay beside the hook', () => {
  let root: string;
  let storeDir: string;
  let projectsRoot: string;
  const NOW = Date.parse('2026-11-04T00:00:00Z');
  const COMMAND_LINE = 'npm install left-pad';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oars-gate-merge-'));
    storeDir = join(root, 'store');
    projectsRoot = join(root, 'projects');
    await mkdir(storeDir, { recursive: true });
    await mkdir(join(projectsRoot, 'C--work-app'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const transcript = async (id: string): Promise<void> => {
    const lines = [
      { type: 'user', timestamp: '2026-10-01T10:00:00.000Z', permissionMode: 'default', message: { role: 'user', content: 'please install left-pad' } },
      { type: 'assistant', timestamp: '2026-10-01T10:00:01.000Z', cwd: root, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: COMMAND_LINE } }] } },
      { type: 'user', timestamp: '2026-10-01T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'added 1 package' }] } },
    ];
    await writeFile(join(projectsRoot, 'C--work-app', 'sess1.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  };

  const hook = (id: string, session: string, command: string): Promise<string> =>
    gateHook(JSON.stringify({ session_id: session, tool_use_id: id, tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'plan' }), {
      storeDir,
      now: () => Date.parse('2026-10-01T10:00:01.500Z'),
      clock: () => 0,
      deadlineMs: 800,
    });

  const fileRows = async (): Promise<Row[]> => parseRows(await readFile(join(storeDir, 'crossings.jsonl'), 'utf8'));

  it('keeps the hook rows it did not match, merges the one it did, and counts it once', async () => {
    await transcript('t1');
    await hook('t1', 'sess1', COMMAND_LINE);
    await hook('t9', 'sess2', 'npm install other-pkg');
    await replay({ storeDir, projectsRoot }, { allow: ['C--work-app'], now: () => NOW });
    const rows = await fileRows();
    const crossings = rows.filter((row): row is CrossingRecord => row.kind === 'crossing');
    expect(crossings.map((row) => `${row.name}:${row.via ?? ''}`).sort()).toEqual(['left-pad:both', 'other-pkg:hook']);
    const both = crossings.find((row) => row.name === 'left-pad');
    expect(both).toMatchObject({ permission: 'plan', ts: '2026-10-01T10:00:01.500Z', origin: 'prompt', status: 'ok', next: 'proceeded', decidedBy: 'operator' });
    // A second replay changes nothing about the count.
    await replay({ storeDir, projectsRoot }, { allow: ['C--work-app'], now: () => NOW });
    expect(reportOf(await fileRows()).crossings).toBe(2);
    expect(liveCrossings(await fileRows())).toHaveLength(2);
  });

  it('seeds the novelty index, so a hook after a replay reads a name the transcripts showed as not new', async () => {
    await transcript('t1');
    expect((await loadIndex(storeDir, join(storeDir, 'crossings.jsonl'))).state).toBe('fresh');
    await replay({ storeDir, projectsRoot }, { allow: ['C--work-app'], now: () => NOW });
    expect((await loadIndex(storeDir, join(storeDir, 'crossings.jsonl'))).state).toBe('ready');
    await hook('t7', 'sess1', COMMAND_LINE);
    const last = (await fileRows()).filter((row): row is CrossingRecord => row.kind === 'crossing' && row.via === 'hook').at(-1);
    // The hook's working folder is not the transcript's project here, so the repository is new; the name and the session are not.
    expect(last?.novelty).toBe('repository');
  });

  it('seeds a readable index even when the replay found no crossing, so the next hook row reads fleet', async () => {
    const lines = [
      { type: 'user', timestamp: '2026-10-01T10:00:00.000Z', permissionMode: 'default', message: { role: 'user', content: 'list files' } },
      { type: 'assistant', timestamp: '2026-10-01T10:00:01.000Z', cwd: root, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'Bash', input: { command: 'ls -la' } }] } },
    ];
    await writeFile(join(projectsRoot, 'C--work-app', 'sess1.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await replay({ storeDir, projectsRoot }, { allow: ['C--work-app'], now: () => NOW });
    expect((await loadIndex(storeDir, join(storeDir, 'crossings.jsonl'))).state).toBe('ready');
    await hook('t7', 'sess1', COMMAND_LINE);
    const last = (await fileRows()).filter((row): row is CrossingRecord => row.kind === 'crossing' && row.via === 'hook').at(-1);
    expect(last?.novelty).toBe('fleet');
  });

  describe('when the hook and the project folder name the same repository', () => {
    // A repository root holding `.git`, a session started at the root, and a project folder named as Claude Code names it.
    const repoWithSession = async (startedIn: string): Promise<string> => {
      const repo = join(root, 'repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'packages', 'app'), { recursive: true });
      const project = slugOf(join(repo, startedIn));
      await mkdir(join(projectsRoot, project), { recursive: true });
      const lines = [
        { type: 'user', timestamp: '2026-10-01T10:00:00.000Z', permissionMode: 'default', message: { role: 'user', content: 'please install left-pad' } },
        { type: 'assistant', timestamp: '2026-10-01T10:00:01.000Z', cwd: join(repo, startedIn), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: COMMAND_LINE } }] } },
        { type: 'user', timestamp: '2026-10-01T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'added 1 package' }] } },
      ];
      await writeFile(join(projectsRoot, project, 'sess1.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
      await replay({ storeDir, projectsRoot }, { allow: [project], now: () => NOW });
      return repo;
    };

    const hookIn = async (cwd: string, session: string): Promise<CrossingRecord | undefined> => {
      await gateHook(JSON.stringify({ session_id: session, tool_use_id: 't9', tool_name: 'Bash', tool_input: { command: COMMAND_LINE }, cwd, permission_mode: 'default' }), {
        storeDir,
        now: () => Date.parse('2026-10-02T10:00:00.000Z'),
        clock: () => 0,
        deadlineMs: 800,
      });
      return (await fileRows()).filter((row): row is CrossingRecord => row.kind === 'crossing' && row.via === 'hook').at(-1);
    };

    it('reads a session started at the repository root as no newer than the session the replay saw', async () => {
      const repo = await repoWithSession('');
      expect((await hookIn(repo, 'sess1'))?.novelty).toBe('none');
      // Another session in the same repository: new to the session, not to the repository.
      expect((await hookIn(repo, 'sess2'))?.novelty).toBe('session');
    });

    it('reads the repository as new when the replayed session started in a subfolder of it (the limit gate.md states)', async () => {
      const repo = await repoWithSession(join('packages', 'app'));
      expect((await hookIn(repo, 'sess2'))?.novelty).toBe('repository');
    });
  });
});
