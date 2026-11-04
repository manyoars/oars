import { describe, expect, it } from 'vitest';
import { GATE_VERSION, type CrossingRecord, type RunRow } from './record.js';
import { LIMITS, formatReport, reportOf } from './report.js';

const run = (extra: Partial<RunRow> = {}): RunRow => ({ kind: 'run', v: GATE_VERSION, day: '2026-11-04', transcripts: 3, unreadable: 1, badLines: 2, calls: 40, crossings: 0, unread: {}, registryRead: false, ...extra });

const crossing = (extra: Partial<CrossingRecord> = {}): CrossingRecord => ({
  kind: 'crossing',
  v: GATE_VERSION,
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

const count = (tally: readonly { value: string; count: number }[], value: string): number | undefined => tally.find((one) => one.value === value)?.count;

describe('the counts', () => {
  const rows = [
    run({ crossings: 4, unread: { 'pipe-to-shell': 2, 'manifest-install': 1 } }),
    crossing({ name: 'alpha' }),
    crossing({ name: 'alpha', session: 's2', next: 'routed-around', status: 'error', removedLater: true }),
    crossing({ name: 'beta', class: 'python-package', form: 'fetch-and-run', program: 'uvx', origin: 'none-seen', decidedBy: 'agent', depth: 'subagent', novelty: 'session' }),
    crossing({ name: 'gamma', class: 'mcp-server', form: 'mcp-call', miss: 'not-found' }),
  ];
  const report = reportOf(rows);

  it('counts crossings by class and form with distinct names', () => {
    expect(report.crossings).toBe(4);
    expect(report.classes).toContainEqual({ class: 'npm-package', form: 'install', count: 2, distinct: 1 });
    expect(report.classes).toContainEqual({ class: 'python-package', form: 'fetch-and-run', count: 1, distinct: 1 });
    expect(report.classes.every((one) => one.count > 0)).toBe(true);
  });

  it('counts every closed field, zeros included, in the vocabulary order', () => {
    expect(count(report.origin, 'prompt')).toBe(3);
    expect(count(report.origin, 'none-seen')).toBe(1);
    expect(count(report.origin, 'web')).toBe(0);
    expect(report.novelty.map((one) => one.value)).toEqual(['fleet', 'repository', 'session', 'none', 'not-read']);
    expect(count(report.decidedBy, 'agent')).toBe(1);
    expect(count(report.next, 'routed-around')).toBe(1);
    expect(count(report.status, 'error')).toBe(1);
    expect(count(report.depth, 'subagent')).toBe(1);
    expect(count(report.miss, 'not-found')).toBe(1);
    expect(report.removedLater).toBe(1);
  });

  it('prints what it counted and the books of the run', () => {
    const text = formatReport(report);
    expect(text).toContain('Crossings: 4');
    expect(text).toContain('npm-package install: 2 (1 distinct)');
    expect(text).toContain('Read 3 transcripts (1 unreadable, 2 torn lines) and 40 tool calls');
    expect(text).toContain('Removed later: 1');
  });

  it('counts the policy the hook rows were written under, and leaves a replay row out of it', () => {
    const counted = reportOf([crossing({ policy: 'default' }), crossing({ toolUseId: 't2', policy: 'default' }), crossing({ toolUseId: 't3', policy: 'invalid' }), crossing({ toolUseId: 't4' })]);
    expect(counted.policy).toEqual([
      { value: 'default', count: 2 },
      { value: 'file', count: 0 },
      { value: 'invalid', count: 1 },
    ]);
    expect(formatReport(counted)).toContain('Policy: default 2, invalid 1');
    expect(formatReport(report)).not.toContain('Policy:');
  });

  it('says the registry state was not read, and never guesses', () => {
    expect(formatReport(report)).toContain('registry state not read');
    expect(formatReport(report)).not.toContain('Against latest');
  });

  it('ends with what replay cannot see, including the shapes it counted and could not name', () => {
    const lines = formatReport(report).split('\n');
    const at = lines.indexOf('Replay cannot see:');
    expect(at).toBeGreaterThan(0);
    const tail = lines.slice(at + 1);
    expect(tail.join('\n')).toContain('2 pipe-to-shell');
    expect(tail.join('\n')).toContain('1 manifest-install');
    for (const limit of LIMITS) expect(tail).toContain(`- ${limit}`);
    expect(lines.at(-1)).toMatch(/^- /);
  });

  it('names the sources replay does not read', () => {
    expect(LIMITS.join(' ')).toMatch(/Codex, Cursor, Copilot, Gemini CLI, Grok Build, or VS Code Copilot Chat/);
  });

  it('shows the registry counts only when the registry was read', () => {
    const read = reportOf([run({ registryRead: true }), crossing({ againstLatest: 'latest', registryState: 'found', registryAge: 'older' }), crossing({ toolUseId: 't2', againstLatest: 'not-latest', registryState: 'not-found', registryAge: 'under-7-days' })]);
    const text = formatReport(read);
    expect(text).not.toContain('registry state not read');
    expect(text).toContain('Against latest: ');
    expect(count(read.registryState, 'not-found')).toBe(1);
    expect(count(read.againstLatest, 'not-latest')).toBe(1);
  });

  it('separates the notes shown from the notes held, and the line each carried', () => {
    const arms = reportOf([
      run(),
      crossing({ name: 'quiet', toolUseId: 't1' }),
      crossing({ name: 'young', toolUseId: 't2', arm: 'shown', lineShown: 'young-name-note' }),
      crossing({ name: 'ghost', toolUseId: 't3', arm: 'held', lineHeld: 'not-found-note' }),
    ]);
    expect(arms.arm).toEqual([{ value: 'none', count: 1 }, { value: 'shown', count: 1 }, { value: 'held', count: 1 }]);
    expect(count(arms.lineShown, 'none')).toBe(2);
    expect(count(arms.lineShown, 'young-name-note')).toBe(1);
    expect(count(arms.lineHeld, 'none')).toBe(2);
    expect(count(arms.lineHeld, 'not-found-note')).toBe(1);
    const text = formatReport(arms);
    expect(text).toContain('Notes: none 1, shown 1, held 1');
    expect(text).toContain('Line shown: none 2, young-name-note 1');
    expect(text).toContain('Line held: none 2, not-found-note 1');
  });

  it('uses no evaluative word anywhere in what it prints', () => {
    const text = formatReport(report) + formatReport(reportOf([run({ registryRead: true }), crossing()])) + LIMITS.join(' ');
    expect(text).not.toMatch(/malicious|threat|attack|danger|unsafe|suspicious|risk|vulnerab|safe|\bbad\b|evil|hostile/i);
  });

  it('reports a run with no crossings', () => {
    const empty = reportOf([run()]);
    expect(empty.crossings).toBe(0);
    expect(empty.classes).toEqual([]);
    expect(formatReport(empty)).toContain('Crossings: 0');
    expect(formatReport(empty)).toContain('Name came from: none\n');
  });
});
