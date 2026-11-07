import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { formatPackageBooks, packageBooks } from './package-books.js';
import { prompt, session, store, tool } from './pool-fixture.js';
import type { ToolObservation, ToolPull } from './schema.js';
import { cleanup, stage } from './test-support.js';
import { vocabulary } from './vocab-load.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const pulling = (id: string, n: number, names: readonly string[], over: Partial<ToolObservation> = {}): ToolObservation =>
  tool(id, n, 'Bash', { pulls: names.map((name): ToolPull => ({ ecosystem: 'npm', name, version: null })), ts: '2026-11-02T10:00:00.000Z', ...over });

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

const NONE: ReadonlySet<string> = new Set();

/** Two public packages (prettier, vitest), one non-public name, two harnesses, a model on the prompt only, and one on the call. */
const fleet = () =>
  store({
    sessions: [session('s1'), session('s2', { harness: 'codex' })],
    prompts: [prompt('s1', 0, { model: 'claude-opus-5-5' }), prompt('s2', 0, { model: 'claude-sonnet-5-5' })],
    tools: [
      pulling('s1', 0, ['prettier']),
      pulling('s1', 1, ['prettier'], { status: 'error', cv: '19', errorCode: '1', ts: '2026-11-04T09:00:00.000Z' }),
      pulling('s2', 0, ['prettier', 'vitest'], { model: 'claude-opus-5-5' }),
      pulling('s2', 1, ['internal-acme-tool']),
    ],
  });

describe('packageBooks', () => {
  it('counts calls, failed calls, sessions, days, and harness and model per public package, and counts non-public names without naming them', () => {
    const result = packageBooks(fleet(), NONE, vocabulary());
    expect(result.rows.map((row) => row.package)).toEqual(['npm:prettier', 'npm:vitest']);
    const [prettier, vitest] = result.rows;
    expect(prettier).toMatchObject({ calls: 3, failed: 1, sessions: 2, firstDay: '2026-11-02', lastDay: '2026-11-04' });
    expect(prettier?.harnessModels).toEqual([
      { harness: 'claude-code', model: 'claude-opus-5-5', calls: 2, failed: 1 },
      { harness: 'codex', model: 'claude-opus-5-5', calls: 1, failed: 0 },
    ]);
    expect(vitest).toMatchObject({ calls: 1, failed: 0, sessions: 1 });
    expect(result.notPublic).toEqual({ names: 1, calls: 1 });
    expect(JSON.stringify(result)).not.toContain('internal-acme-tool');
  });

  it('counts a call that pulls two non-public names as one call, and the same name in two calls as one name', () => {
    const from = store({
      sessions: [session('s1')],
      tools: [pulling('s1', 0, ['internal-acme-tool', 'internal-acme-other']), pulling('s1', 1, ['internal-acme-tool'])],
    });
    expect(packageBooks(from, NONE, vocabulary()).notPublic).toEqual({ names: 2, calls: 2 });
  });

  it('counts only the calls inside the --since window in the exclusion line', () => {
    const from = store({
      sessions: [session('s1'), session('gone')],
      tools: [pulling('s1', 0, ['prettier']), pulling('gone', 0, ['prettier'], { ts: '2026-10-01T10:00:00.000Z' }), pulling('gone', 1, ['prettier'])],
    });
    expect(packageBooks(from, new Set(['gone']), vocabulary()).excluded.calls).toBe(2);
    expect(packageBooks(from, new Set(['gone']), vocabulary(), '2026-11-01T00:00:00.000Z').excluded.calls).toBe(1);
  });

  it('reads a subagent call with no model of its own as no model, since only a main session\'s prompts are stored', () => {
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { model: 'claude-sonnet-5-5' })],
      subagents: [session('sub1', { parent: 's1', agentType: 'general-purpose' })],
      tools: [pulling('sub1', 0, ['prettier'], { parent: 's1', agentType: 'general-purpose', prompt: 0 })],
    });
    expect(packageBooks(from, NONE, vocabulary()).rows[0]?.harnessModels.map((cell) => cell.model)).toEqual(['no model']);
  });

  it('takes the model from the prompt when the call names none, and reads a name outside the model snapshot as another model', () => {
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0, { model: 'claude-sonnet-5-5' }), prompt('s1', 1, { model: 'my-private-model' })],
      tools: [pulling('s1', 0, ['prettier'], { prompt: 0 }), pulling('s1', 1, ['prettier'], { prompt: 1 }), pulling('s1', 2, ['prettier'], { prompt: null })],
    });
    const cells = packageBooks(from, NONE, vocabulary()).rows[0]?.harnessModels.map((cell) => cell.model);
    expect(cells).toEqual(['another model', 'claude-sonnet-5-5', 'no model']);
  });

  it('removes a transcript when it or its main session is excluded, subagent included, and says how many', () => {
    const from = store({
      sessions: [session('main'), session('keep')],
      subagents: [session('sub', { parent: 'main' })],
      prompts: [prompt('main', 0), prompt('keep', 0)],
      tools: [pulling('main', 0, ['prettier']), pulling('sub', 0, ['prettier'], { parent: 'main' }), pulling('sub', 1, ['prettier'], { parent: 'main' }), pulling('keep', 0, ['prettier'])],
    });
    const result = packageBooks(from, new Set(['main']), vocabulary());
    expect(result.rows[0]).toMatchObject({ calls: 1, sessions: 1 });
    expect(result.excluded).toEqual({ transcripts: 2, calls: 3 });
    expect(formatPackageBooks(result)).toContain('Exclusions applied: 2 transcripts and 3 calls removed before counting.');
  });

  it('counts a failed call from before error classes as not measured, never as a zero class', () => {
    const from = store({
      sessions: [session('s1')],
      prompts: [prompt('s1', 0)],
      tools: [
        pulling('s1', 0, ['vitest'], { status: 'error', cv: '10' }),
        pulling('s1', 1, ['vitest'], { status: 'error', cv: '19', errorCode: '1' }),
        pulling('s1', 2, ['vitest'], { status: 'error', cv: '19' }),
      ],
    });
    const row = packageBooks(from, NONE, vocabulary()).rows[0];
    expect(row).toMatchObject({ failed: 3, notMeasured: 1, errorClasses: { '1': 1, 'no class recorded': 1 } });
    expect(formatPackageBooks({ rows: row === undefined ? [] : [row], notPublic: { names: 0, calls: 0 }, excluded: { transcripts: 0, calls: 0 } })).toContain('not measured 1');
  });

  it('keeps only calls inside a since window and ignores pulls that are not packages', () => {
    const from = store({
      sessions: [session('s1')],
      tools: [pulling('s1', 0, ['prettier']), pulling('s1', 1, ['prettier'], { ts: null }), tool('s1', 2, 'Bash', { pulls: [{ ecosystem: 'mcp', name: 'srv', version: null }] }), tool('s1', 3, 'Read')],
    });
    expect(packageBooks(from, NONE, vocabulary(), '2026-11-01T00:00:00.000Z').rows[0]?.calls).toBe(1);
    expect(packageBooks(from, NONE, vocabulary(), '2026-11-03T00:00:00.000Z').rows).toEqual([]);
    expect(formatPackageBooks(packageBooks(store({}), NONE, vocabulary()))).toContain('No public package pulls in the store.');
  });
});

describe('oars sessions books --by package', () => {
  const termsFile = (root: string, terms: string): string => {
    const file = join(root, 'terms.txt');
    writeFileSync(file, terms);
    return file;
  };

  it('applies the exclusion scan: a missing term file excludes every transcript, and a term that matches nothing excludes none', async () => {
    const staged = stage();
    const h = harness({ OARS_EXCLUSION_TERMS: join(staged.root, 'absent.txt') });
    h.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], h.deps)).toBe(ExitCode.OK);
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'books', '--by', 'package'], h.deps)).toBe(ExitCode.OK);
    const all: unknown = JSON.parse(h.out.join(''));
    expect(field(all, 'by')).toBe('package');
    expect(Number(field(field(all, 'excluded'), 'transcripts'))).toBeGreaterThan(0);

    const open = harness({ OARS_EXCLUSION_TERMS: termsFile(staged.root, 'zz-no-such-term-zz\n') });
    open.deps.sessions = staged.runtime;
    expect(await run(['--json', 'sessions', 'books', '--by', 'package'], open.deps)).toBe(ExitCode.OK);
    expect(field(field(JSON.parse(open.out.join('')), 'excluded'), 'transcripts')).toBe(0);
    open.out.length = 0;
    expect(await run(['sessions', 'books', '--by', 'package', '--since', '3650'], open.deps)).toBe(ExitCode.OK);
    expect(open.out.join('')).toContain('Exclusions applied: 0 transcripts and 0 calls removed before counting.');
  });

  it('refuses --repo with --by package', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'books', '--by', 'package', '--repo', 'x'], h.deps)).toBe(ExitCode.USAGE);
  });
});
