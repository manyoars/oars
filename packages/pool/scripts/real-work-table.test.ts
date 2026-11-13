// The real-work table (t1231): fixture stores built in a temp folder, with an invented exclusion term and invented transcripts. No test reads a real store.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_INPUT_KEYS } from '../../cli/src/sessions/public-vocabulary.js';
import { PROMPT_CLASSES } from '../../cli/src/sessions/schema.js';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { HARNESS_NAMES, main, MODEL_PREFIXES, SPEC_VERSION, tableOf, type Table } from './real-work-table.js';

const TERM = 'zorblax';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const line = (value: object): string => JSON.stringify(value);
const id = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

interface Call {
  tool: string;
  input: object;
  ok: boolean;
}
interface Prompt {
  text: string;
  calls: Call[];
}
interface Spec {
  id: string;
  project: string;
  version: string;
  model: string;
  prompts: Prompt[];
}

const bash = (ok: boolean): Call => ({ tool: 'Bash', input: { command: 'npm test' }, ok });
const edit = (): Call => ({ tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, ok: true });
const read = (): Call => ({ tool: 'Read', input: { file_path: 'src/a.ts' }, ok: true });

// A transcript the way the harness writes it: a user line per prompt, then an assistant line and a result line per call.
const transcript = (spec: Spec, cwd: string): string[] => {
  const lines: string[] = [];
  let n = 0;
  let second = 0;
  const at = (): string => `2026-06-01T10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second++ % 60).padStart(2, '0')}.000Z`;
  for (const prompt of spec.prompts) {
    n += 1;
    lines.push(line({ type: 'user', uuid: `${spec.id.slice(0, 8)}-b${String(n).padStart(3, '0')}-4222-8222-222222222222`, parentUuid: null, isSidechain: false, timestamp: at(), version: spec.version, sessionId: spec.id, cwd, message: { role: 'user', content: prompt.text } }));
    for (const call of prompt.calls) {
      n += 1;
      const tool = `toolu_${spec.id.slice(0, 4)}${String(n)}`;
      lines.push(line({ type: 'assistant', uuid: `${spec.id.slice(0, 8)}-a${String(n).padStart(3, '0')}-4222-8222-222222222222`, parentUuid: null, isSidechain: false, timestamp: at(), version: spec.version, sessionId: spec.id, requestId: `req_${spec.id.slice(0, 4)}${String(n)}`, message: { role: 'assistant', model: spec.model, content: [{ type: 'tool_use', id: tool, name: call.tool, input: call.input }], usage: { input_tokens: 100, output_tokens: 50 } } }));
      lines.push(line({ type: 'user', uuid: `${spec.id.slice(0, 8)}-b${String(n).padStart(3, '0')}-4333-8333-333333333333`, parentUuid: null, isSidechain: false, timestamp: at(), version: spec.version, sessionId: spec.id, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, ...(call.ok ? {} : { is_error: true }), content: call.ok ? 'done' : 'Error: Exit code 1' }] } }));
    }
  }
  return lines;
};

interface Fixture {
  root: string;
  runtime: SessionsRuntime;
  terms: string;
  owners: string;
  out: string;
  add: (spec: Spec) => void;
  stored: () => Promise<void>;
}

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-real-work-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  mkdirSync(projectsRoot);
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, '.git', 'config'), `[remote "origin"]\n\turl = https://example.com/acme/app.git\n`);
  const terms = join(root, 'terms.txt');
  writeFileSync(terms, `${TERM}\n`);
  const owners = join(root, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
  const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  const add = (spec: Spec): void => {
    const file = join(projectsRoot, spec.project, `${spec.id}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${transcript(spec, cwd).join('\n')}\n`);
  };
  const stored = async (): Promise<void> => {
    await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  };
  return { root, runtime, terms, owners, out: join(root, 'table'), add, stored };
};

const OPTIONS = (f: Fixture, extra: { minSessions?: number } = {}) => ({ terms: f.terms, owners: f.owners, minSessions: extra.minSessions ?? 1, date: '2026-11-13' });

// A session of the main model on the older harness bucket with one failure that an edit recovers, one that nothing recovers.
const older = (n: number, project = '-work-oars'): Spec => ({
  id: id(n),
  project,
  version: '2.1.300',
  model: 'claude-opus-5-5',
  prompts: [
    { text: 'fix the parser', calls: [read(), bash(false), edit(), bash(true)] },
    { text: 'run it again', calls: [bash(false), read(), read(), read(), read(), read(), read()] },
  ],
});
const newer = (n: number): Spec => ({ id: id(n), project: '-work-oars', version: '2.1.320', model: 'claude-sonnet-5-5', prompts: [{ text: 'fix the parser', calls: [read(), bash(true), edit()] }] });

const build = async (f: Fixture, extra: { minSessions?: number } = {}): Promise<Table> => tableOf(f.runtime, OPTIONS(f, extra));

describe('real-work table', () => {
  it('gives a known table for a fixture store, byte for byte', async () => {
    const f = fixture();
    f.add(older(1));
    f.add(older(2));
    f.add(newer(3));
    await f.stored();
    const table = await build(f);
    const text = `${JSON.stringify(table, null, 2)}\n`;
    expect(text).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'real-work-table.expected.json'), 'utf8'));
    expect(await build(f).then((again) => `${JSON.stringify(again, null, 2)}\n`)).toBe(text);
  });

  it('runs the exclusion terms and the owner filter before any count, with counts by reason in the header', async () => {
    const plain = fixture();
    plain.add(older(1));
    await plain.stored();
    const before = await build(plain);

    const f = fixture();
    f.add(older(1));
    // The listed term sits in a prompt of a session that would otherwise add calls; another session sits in a folder no owner names.
    f.add({ ...older(2), prompts: [{ text: `fix the ${TERM} parser`, calls: [bash(false), bash(false), bash(false)] }] });
    f.add(older(3, '-work-elsewhere'));
    await f.stored();
    const table = await build(f);
    expect(table.header.excluded).toMatchObject({ term: 1, noOwner: 1 });
    expect(table.header.sessions).toBe(3);
    expect(table.header.counted).toBe(1);
    expect(table.rows).toEqual(before.rows);
  });

  it('leaves out every row under the minimum n, and the minimum is an option', async () => {
    const f = fixture();
    f.add(older(1));
    f.add(older(2));
    f.add(newer(3));
    await f.stored();
    const all = await build(f);
    expect(all.rows.some((row) => row.sessions === 1)).toBe(true);
    const filtered = await build(f, { minSessions: 2 });
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.every((row) => row.sessions >= 2)).toBe(true);
    expect(filtered.header.leftOut).toBeGreaterThan(0);
    expect(filtered.header.minSessions).toBe(2);
    const defaulted = await tableOf(f.runtime, { terms: f.terms, owners: f.owners, date: '2026-11-13' });
    expect(defaulted.header.minSessions).toBe(5);
    expect(defaulted.rows).toEqual([]);
  });

  it('holds no string outside the closed vocabulary', async () => {
    const f = fixture();
    f.add(older(1));
    f.add({ ...newer(2), model: 'my-private-finetune-v2', prompts: [{ text: 'x', calls: [{ tool: 'mcp__acme_secret__lookup', input: { q: 1 }, ok: false }, read()] }] });
    await f.stored();
    const table = await build(f);
    const allowed = new Set<string>([
      ...HARNESS_NAMES, ...PROMPT_CLASSES, ...TOOL_INPUT_KEYS.keys(), 'other', 'unknown', '2.1.30x', '2.1.32x', 'claude-opus-5-5', 'claude-sonnet-5-5', 'one fleet', SPEC_VERSION, '2026-11-13', 'cell', 'tool',
    ]);
    const keys = new Set(['spec', 'label', 'builtOn', 'sessions', 'counted', 'excluded', 'minSessions', 'leftOut', 'header', 'rows', 'kind', 'model', 'harness', 'versionBucket', 'tool', 'calls', 'failures', 'failureRate', 'recovered', 'callsToRecover', 'editFollowedShare', 'prompts', 'interventions', 'interventionsPerPrompt', 'tokensPerPrompt', 'class', 'cell',
      'term', 'noRaw', 'noTerms', 'unreadable', 'noOwner', 'excludedByReason']);
    const strings: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') strings.push(`${path}=${value}`);
      else if (Array.isArray(value)) value.forEach((item, at) => {
        walk(item, `${path}[${String(at)}]`);
      });
      else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          expect(keys.has(key), `key ${key}`).toBe(true);
          walk(item, `${path}.${key}`);
        }
      }
    };
    walk(table, '');
    expect(strings.length).toBeGreaterThan(0);
    for (const entry of strings) expect(allowed.has(entry.slice(entry.indexOf('=') + 1)), entry).toBe(true);
    const text = JSON.stringify(table);
    expect(text).not.toContain('my-private-finetune');
    expect(text).not.toContain('acme_secret');
    expect(table.rows.some((row) => row.kind === 'cell' && row.model === 'other')).toBe(true);
    expect(table.rows.some((row) => row.kind === 'tool' && row.tool === 'other')).toBe(true);
    expect(MODEL_PREFIXES.length).toBeGreaterThan(0);
  });

  it('carries the build date, the store session count, the label, and the spec version in the header', async () => {
    const f = fixture();
    f.add(older(1));
    f.add(newer(2));
    await f.stored();
    const { header } = await build(f);
    expect(header).toMatchObject({ builtOn: '2026-11-13', sessions: 2, label: 'one fleet', spec: SPEC_VERSION });
  });

  it('refuses to write inside a repository and writes table.json outside one', async () => {
    const f = fixture();
    f.add(older(1));
    await f.stored();
    const printed: string[] = [];
    const io = { runtime: f.runtime, print: (text: string) => printed.push(text), now: () => Date.parse('2026-11-13T12:00:00Z') };
    const args = (out: string): string[] => ['--terms', f.terms, '--owners', f.owners, '--out', out, '--min-sessions', '1'];

    const inside = join(f.root, 'work', 'app', 'out');
    expect(await main(args(inside), io)).toBe(2);
    expect(printed.join('\n')).toContain('inside a git repository');

    expect(await main(args(f.out), io)).toBe(0);
    const written: unknown = JSON.parse(readFileSync(join(f.out, 'table.json'), 'utf8'));
    expect(written).toMatchObject({ header: { builtOn: '2026-11-13' } });
    expect(await main(['--terms', f.terms], io)).toBe(2);
  });
});
