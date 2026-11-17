// The real-work table: fixture stores built in a temp folder, with an invented exclusion term and invented transcripts. No test reads a real store.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES, TOOL_INPUT_KEYS } from '../../cli/src/sessions/public-vocabulary.js';
import { PROMPT_CLASSES } from '../../cli/src/sessions/schema.js';
import { bash, type Call, edit, failedEdit, fixture, id, inSkill, mcp, read, removeFixtures, TERM, type Fixture, type Spec } from './real-work-fixture.js';
import { HARNESS_NAMES, main, serverName, SPEC_VERSION, tableOf, type Table } from './real-work-table.js';

afterEach(removeFixtures);

const OPTIONS = (f: Fixture, extra: { minSessions?: number } = {}) => ({ terms: f.terms, owners: f.owners, minSessions: extra.minSessions ?? 1, date: '2026-11-13' });

// A session of the main model on the older harness bucket with one failure that an edit recovers, one that nothing recovers; the second prompt asks for an undo, so the first is a known intervention and the last prompt is unknown.
const older = (n: number, project = '-work-oars'): Spec => ({
  id: id(n),
  project,
  version: '2.1.300',
  model: 'claude-opus-5-5',
  prompts: [
    { text: 'fix the parser', calls: [read(), bash(false), edit(), bash(true)] },
    { text: 'revert that', calls: [bash(false), read(), read(), read(), read(), read(), read()] },
  ],
});
const newer = (n: number): Spec => ({ id: id(n), project: '-work-oars', version: '2.1.320', model: 'claude-sonnet-5-5', prompts: [{ text: 'fix the parser', calls: [read(), bash(true), edit()] }] });

const run = (command: string, ok: boolean): Call => ({ tool: 'Bash', input: { command }, ok });
// The older session plus two npx calls, for the tests that need package rows; `older` itself stays free of them.
const withPackages = (n: number): Spec => ({
  ...older(n),
  prompts: [
    { text: 'fix the parser', calls: [read(), bash(false), edit(), bash(true), run('npx prettier@3.3.0 --check .', true), run('npx @acme/internal-tool --go', false)] },
    { text: 'revert that', calls: [bash(false), read(), read(), read(), read(), read(), read()] },
  ],
});

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
    // Only what this fixture can print: its one private server is other, so no public server or skill name belongs here.
    const allowed = new Set<string>([
      ...HARNESS_NAMES, ...PROMPT_CLASSES, ...TOOL_INPUT_KEYS.keys(), 'other', 'unknown', '2.1.30x', '2.1.32x', 'claude-opus-5-5', 'claude-sonnet-5-5', 'one fleet', SPEC_VERSION, '2026-11-13', 'cell', 'tool', 'server',
    ]);
    const keys = new Set(['spec', 'label', 'builtOn', 'sessions', 'counted', 'excluded', 'minSessions', 'leftOut', 'header', 'rows', 'kind', 'model', 'harness', 'versionBucket', 'tool', 'calls', 'failures', 'failureRate', 'recovered', 'callsToRecover', 'editFollowedShare', 'prompts', 'promptsKnown', 'interventions', 'interventionsPerPrompt', 'tokensPerPrompt', 'class', 'name', 'thin', 'recoveredRate',
      'term', 'noRaw', 'noTerms', 'unreadable', 'noOwner']);
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
  });

  it('names a model only when the closed grammar does, so a private build is other', async () => {
    const f = fixture();
    const privateNames = ['claude-acme-internal-ft', 'gpt-acmecorp-secret', 'o3private'];
    privateNames.forEach((model, at) => {
      f.add({ ...newer(at + 1), model });
    });
    await f.stored();
    const table = await build(f);
    const text = JSON.stringify(table);
    for (const name of privateNames) expect(text).not.toContain(name);
    expect(table.rows.flatMap((row) => (row.kind === 'cell' ? [row.model] : []))).toEqual(['other']);
  });

  it('counts a recovery only as a later edit that did not fail, in the same prompt', async () => {
    const failedThenFailedEdit = fixture();
    failedThenFailedEdit.add({ ...newer(1), prompts: [{ text: 'fix it', calls: [bash(false), failedEdit()] }] });
    await failedThenFailedEdit.stored();
    const next = fixture();
    next.add({ ...newer(1), prompts: [{ text: 'fix it', calls: [bash(false)] }, { text: 'go on', calls: [edit()] }] });
    await next.stored();
    const clean = fixture();
    clean.add({ ...newer(1), prompts: [{ text: 'fix it', calls: [bash(false), read(), edit()] }] });
    await clean.stored();
    for (const [f, failures] of [[failedThenFailedEdit, 2], [next, 1]] as const) {
      for (const row of (await build(f)).rows) {
        if (row.kind === 'tool' && row.tool !== 'Bash') continue;
        expect(row, row.kind).toMatchObject({ failures: row.kind === 'cell' ? failures : 1, recovered: 0, callsToRecover: null, editFollowedShare: 0 });
      }
    }
    // A clean read in between does not count, the edit behind it does, two calls away.
    const rows = (await build(clean)).rows.filter((row) => row.kind === 'cell' || (row.kind === 'tool' && row.tool === 'Bash'));
    for (const row of rows) expect(row).toMatchObject({ failures: 1, recovered: 1, callsToRecover: 2, editFollowedShare: 1 });
  });

  it('divides interventions by the prompts with a known intervention and states that n', async () => {
    const f = fixture();
    // The plain follow-up reads as `none`, so only the undo counts: a rule that counted every known prompt would give 1.
    f.add({ ...older(1), prompts: [{ text: 'fix the parser', calls: [read(), read()] }, { text: 'now add a test', calls: [read(), edit()] }, { text: 'revert that', calls: [read()] }, { text: 'thanks', calls: [read()] }] });
    await f.stored();
    const cell = (await build(f)).rows.find((row) => row.kind === 'cell');
    expect(cell).toMatchObject({ promptsKnown: 3, interventions: 1, interventionsPerPrompt: 0.3333 });
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

  it('reads the positional store folder and the --date flag through main', async () => {
    const f = fixture();
    f.add(older(1));
    f.add(newer(2));
    await f.stored();
    const printed: string[] = [];
    // The runtime's own store is somewhere else, so only the positional folder can supply the sessions.
    const io = { runtime: { ...f.runtime, storeDir: join(f.root, 'elsewhere') }, print: (text: string) => printed.push(text), now: () => Date.parse('2026-11-13T12:00:00Z') };
    expect(await main([f.runtime.storeDir, '--date', '2026-01-02', '--terms', f.terms, '--owners', f.owners, '--out', f.out, '--min-sessions', '1'], io)).toBe(0);
    const written: unknown = JSON.parse(readFileSync(join(f.out, 'table.json'), 'utf8'));
    expect(written).toMatchObject({ header: { builtOn: '2026-01-02', sessions: 2 } });
  });

  describe('server and skill rows', () => {
    // Two sessions on each of two harness buckets; github fails once in each older session (an edit recovers it, one call on), and once in the newer.
    const withServers = async (): Promise<Fixture> => {
      const f = fixture();
      const old = (n: number): Spec => ({ ...older(n), prompts: [{ text: 'fix the parser', calls: [mcp('github', false), edit(), mcp('github', true)] }, { text: 'again', calls: [mcp('context7', true), read()] }] });
      f.add(old(1));
      f.add(old(2));
      f.add({ ...newer(3), prompts: [{ text: 'fix the parser', calls: [mcp('github', false), read(), edit()] }] });
      f.add({ ...newer(4), prompts: [{ text: 'fix the parser', calls: [mcp('github', true), mcp('github', true)] }] });
      await f.stored();
      return f;
    };
    const scoped = (table: Table) => table.rows.flatMap((row) => (row.kind === 'server' || row.kind === 'skill' ? [row] : []));

    it('prints one row per MCP server, harness, and bucket, with the counts and rates, each labeled one fleet', async () => {
      const rows = scoped(await build(await withServers(), { minSessions: 2 }));
      expect(rows.map((row) => [row.kind, row.name, row.versionBucket, row.sessions, row.calls, row.failures, row.recovered])).toEqual([
        ['server', 'context7', '2.1.30x', 2, 2, 0, 0],
        ['server', 'github', '2.1.30x', 2, 4, 2, 2],
        ['server', 'github', '2.1.32x', 2, 3, 1, 1],
      ]);
      expect(rows.find((row) => row.name === 'github' && row.versionBucket === '2.1.30x')).toMatchObject({ harness: 'claude-code', label: 'one fleet', thin: false, failureRate: 0.5, recoveredRate: 1, callsToRecover: 1 });
      // The newer bucket has one failure, under the n of two a rate needs, so its failure count prints and its recovered rate and median do not.
      expect(rows.find((row) => row.name === 'github' && row.versionBucket === '2.1.32x')).toMatchObject({ failureRate: 0.3333, recoveredRate: null, callsToRecover: null, thin: false });
      expect(rows.every((row) => row.label === 'one fleet')).toBe(true);
    });

    it('reads the server with each harness own spelling, and a server off the public list as other', () => {
      expect(serverName('claude-code', 'mcp__github__lookup')).toBe('github');
      expect(serverName('cursor', 'mcp_github_lookup')).toBe('github');
      expect(serverName('gemini', 'mcp_github_lookup')).toBe('github');
      expect(serverName('cursor', 'mcp_acme_lookup')).toBe('other');
      // The claude-code spelling is no MCP call to cursor, and a plain tool is none anywhere.
      expect(serverName('cursor', 'mcp__github__lookup')).toBeUndefined();
      expect(serverName('claude-code', 'Read')).toBeUndefined();
    });

    it('takes the median of the calls to recover, not the mean', async () => {
      const f = fixture();
      const one = (n: number, between: number): Spec => ({ ...newer(n), prompts: [{ text: 'fix it', calls: [mcp('github', false), ...Array.from({ length: between }, read), edit()] }] });
      // Recoveries 1, 2, and 4 calls away: the mean is 2.3333 and the median 2.
      for (const [n, between] of [[1, 0], [2, 1], [3, 3]] as const) f.add(one(n, between));
      await f.stored();
      expect(scoped(await build(f, { minSessions: 2 }))).toMatchObject([{ name: 'github', failures: 3, recovered: 3, callsToRecover: 2, recoveredRate: 1 }]);
    });

    it('prints per-skill rows from the skill the call ran in, and a skill off the public list as other', async () => {
      const f = fixture();
      const spec = (n: number, skill: string): Spec => ({ ...newer(n), prompts: [{ text: 'go', calls: [inSkill(skill, bash(false)), inSkill(skill, edit()), read()] }] });
      f.add(spec(1, 'commit'));
      f.add(spec(2, 'commit'));
      f.add(spec(3, 'pdf'));
      f.add(spec(4, 'pdf'));
      f.add(spec(5, 'acme-private-skill'));
      f.add(spec(6, 'acme-secret-skill'));
      await f.stored();
      const table = await build(f, { minSessions: 2 });
      expect(scoped(table).map((row) => [row.kind, row.name, row.sessions, row.calls, row.failures, row.recovered, row.callsToRecover])).toEqual([
        ['skill', 'commit', 2, 4, 2, 2, 1],
        ['skill', 'other', 2, 4, 2, 2, 1],
        ['skill', 'pdf', 2, 4, 2, 2, 1],
      ]);
      expect(JSON.stringify(table)).not.toContain('acme');
    });

    it('reads a plugin skill and a connector server by name once listed, and an unlisted one as other', async () => {
      const f = fixture();
      const spec = (n: number, skill: string): Spec => ({ ...newer(n), prompts: [{ text: 'go', calls: [inSkill(skill, bash(false)), inSkill(skill, edit()), mcp(skill === 'superpowers:brainstorming' ? 'chrome-devtools' : 'claude_ai_Private', true), read()] }] });
      f.add(spec(1, 'superpowers:brainstorming'));
      f.add(spec(2, 'superpowers:brainstorming'));
      f.add(spec(3, 'superpowers:acme-private'));
      f.add(spec(4, 'superpowers:acme-private'));
      await f.stored();
      const names = scoped(await build(f, { minSessions: 2 })).map((row) => [row.kind, row.name]);
      expect(names).toEqual(expect.arrayContaining([['skill', 'superpowers:brainstorming'], ['server', 'chrome-devtools'], ['skill', 'other'], ['server', 'other']]));
      expect(JSON.stringify(names)).not.toContain('acme');
      expect(JSON.stringify(names)).not.toContain('claude_ai_Private');
      expect(serverName('claude-code', 'mcp__claude_ai_Gmail__x')).toBe('claude_ai_Gmail');
      expect(serverName('claude-code', 'mcp__claude_ai_Google_Calendar__x')).toBe('claude_ai_Google_Calendar');
      expect(serverName('claude-code', 'mcp__claude_ai_Acme_CRM__x')).toBe('other');
    });

    it('prints a row under the minimum as thin, with its counts and no rate', async () => {
      const f = await withServers();
      const rows = scoped(await build(f, { minSessions: 3 }));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatchObject({ thin: true, failureRate: null, recoveredRate: null, callsToRecover: null, label: 'one fleet' });
      expect(rows.find((row) => row.name === 'github' && row.versionBucket === '2.1.30x')).toMatchObject({ sessions: 2, calls: 4, failures: 2, recovered: 2 });
      // A thin row is kept, so the header's count of left-out rows is the existing rows' alone.
      const wide = await build(f, { minSessions: 1 });
      expect(scoped(wide).some((row) => row.thin)).toBe(false);
    });

    it('leaves the existing rows and header as they were when the store holds no MCP or skill call', async () => {
      const f = fixture();
      f.add(older(1));
      f.add(older(2));
      f.add(newer(3));
      await f.stored();
      const table = await build(f);
      expect(scoped(table)).toEqual([]);
      expect(table.rows.every((row) => row.kind === 'cell' || row.kind === 'tool')).toBe(true);
      expect(`${JSON.stringify(table, null, 2)}
`).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'real-work-table.expected.json'), 'utf8'));
    });
  });

  describe('package rows', () => {
    const packages = (table: Table) => table.rows.flatMap((row) => (row.kind === 'package' ? [row] : []));
    const prompts = (...calls: Call[]): Spec['prompts'] => [{ text: 'run it', calls }];

    it('counts a runner step as using a package, drops the version, keeps the scope, and ignores an install alone', async () => {
      const f = fixture();
      const spec = (n: number, command: string): Spec => ({ ...newer(n), prompts: prompts(run(command, true)) });
      f.add(spec(1, 'npx prettier@3.3.0 --check .'));
      f.add(spec(2, 'npx -y @playwright/test@latest test'));
      f.add(spec(3, 'uvx ruff check .'));
      f.add(spec(4, 'pipx run black .'));
      f.add(spec(5, 'pnpm dlx vite build'));
      f.add(spec(6, 'npm install prettier'));
      f.add(spec(7, 'npx prettier && npm install eslint'));
      await f.stored();
      const rows = packages(await build(f, { minSessions: 1 }));
      expect(rows.map((row) => [row.name, row.sessions, row.calls])).toEqual([['@playwright/test', 1, 1], ['black', 1, 1], ['prettier', 2, 2], ['ruff', 1, 1], ['vite', 1, 1]]);
    });

    it('gives a known table with package rows, byte for byte', async () => {
      const f = fixture();
      f.add(withPackages(1));
      f.add(withPackages(2));
      f.add(newer(3));
      await f.stored();
      const text = `${JSON.stringify(await build(f), null, 2)}
`;
      expect(text).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'real-work-table.packages.expected.json'), 'utf8'));
    });

    it('prints package rows thin under the default minimum, not left out', async () => {
      const f = fixture();
      f.add(withPackages(1));
      f.add(withPackages(2));
      await f.stored();
      const defaulted = await tableOf(f.runtime, { terms: f.terms, owners: f.owners, date: '2026-11-13' });
      expect(defaulted.rows.length).toBeGreaterThan(0);
      expect(defaulted.rows.every((row) => row.kind === 'package' && row.thin)).toBe(true);
    });

    it('counts only the runner step of a call: an install step beside it never counts', async () => {
      const f = fixture();
      f.add({ ...newer(1), prompts: prompts(run('uvx ruff && uv pip install black', true)) });
      f.add({ ...newer(2), prompts: prompts(run('uvx ruff && uv tool install mypy', true)) });
      f.add({ ...newer(3), prompts: prompts(run('npx prettier --write . && git add -A', true)) });
      f.add({ ...newer(4), prompts: prompts(run('uv pip install black', true), run('uv tool install mypy', true)) });
      await f.stored();
      const rows = packages(await build(f, { minSessions: 1 }));
      expect(rows.map((row) => [row.name, row.sessions, row.calls])).toEqual([['prettier', 1, 1], ['ruff', 2, 2]]);
    });

    it('counts a yarn dlx step as a runner, and bunx as none because capture reads it as an unknown program', async () => {
      const f = fixture();
      f.add({ ...newer(1), prompts: prompts(run('bunx vite build', true)) });
      f.add({ ...newer(2), prompts: prompts(run('yarn dlx prettier --check .', true)) });
      await f.stored();
      const rows = packages(await build(f, { minSessions: 1 }));
      expect(rows.map((row) => [row.name, row.sessions, row.calls])).toEqual([['prettier', 1, 1]]);
    });

    it('prints a package name only from the public list, and any other as other', async () => {
      const f = fixture();
      f.add(withPackages(1));
      f.add(withPackages(2));
      await f.stored();
      const table = await build(f, { minSessions: 2 });
      expect(packages(table).map((row) => [row.name, row.sessions, row.calls, row.failures])).toEqual([['other', 2, 2, 2], ['prettier', 2, 2, 0]]);
      expect(JSON.stringify(table)).not.toContain('acme');
      expect(PUBLIC_PACKAGES.has('@acme/internal-tool')).toBe(false);
    });

    it('labels each row one fleet, and prints a row under the minimum as thin with no rate', async () => {
      const f = fixture();
      f.add(withPackages(1));
      f.add(withPackages(2));
      await f.stored();
      for (const row of packages(await build(f, { minSessions: 2 }))) expect(row).toMatchObject({ label: 'one fleet', thin: false, harness: 'claude-code', versionBucket: '2.1.30x' });
      const thin = packages(await build(f, { minSessions: 3 }));
      expect(thin.length).toBe(2);
      for (const row of thin) expect(row).toMatchObject({ thin: true, failureRate: null, recoveredRate: null, callsToRecover: null, label: 'one fleet' });
    });

    it('holds no name outside the public lists, no path, and no address in the fixture table', async () => {
      const f = fixture();
      f.add(withPackages(1));
      f.add({ ...older(2), prompts: prompts(run('npx prettier C:\\work\\acme\\x.ts', true), run('npx prettier ./src/secret/file.ts', true), run('uvx ruff https://acme.example.com/x', true), run('npx @acme/internal-tool admin@acme.example.com', false)) });
      await f.stored();
      const table = await build(f, { minSessions: 1 });
      const text = JSON.stringify(table);
      for (const row of packages(table)) expect(row.name === 'other' || PUBLIC_PACKAGES.has(row.name), row.name).toBe(true);
      expect(text).not.toMatch(/acme|internal-tool|secret|example\.com|@[a-z0-9-]+\.[a-z]|https?:|[A-Za-z]:\\|\.\/|\/src\//i);
    });
  });
});
