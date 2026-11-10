// The first sale's sample pack (P98 (10) to (12)): fixture stores, built in a temp folder, with an invented term and invented instruction text.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { paths, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { deposit } from '../../cli/src/sessions/store.js';
import { buildPack, main, matchIdOf, ownerOf, parseOwners, serverKeyOf, USAGE, type ManifestRow, type PackOptions } from './sample-pack.js';

const TERM = 'zorblax';
const CLAUDE_MD_LINE = 'Always fold the green napkins before lunch';
const MEMORY_LINE = 'violet-otter memory: the kettle lives on shelf nine';
const USER_TEXT = 'please rename the helper in parse.ts';
const OWNERS = [
  { folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' },
  { folder: '*-shop*', owner: 'Switchyard Software Company', license: null },
];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const S = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

const line = (value: object): string => JSON.stringify(value);
const at = (n: number): string => `2026-06-01T10:00:${String(n).padStart(2, '0')}.000Z`;
const user = (session: string, n: number, content: string): string =>
  line({ type: 'user', uuid: `${session}-u${String(n)}`, parentUuid: null, isSidechain: false, timestamp: at(n), version: '2.1.300', sessionId: session, cwd: '/work/app', message: { role: 'user', content } });
const assistant = (session: string, n: number, text: string): string =>
  line({ type: 'assistant', uuid: `${session}-a${String(n)}`, parentUuid: `${session}-u${String(n)}`, isSidechain: false, timestamp: at(n + 1), version: '2.1.300', sessionId: session, requestId: `req_${session}_${String(n)}`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } } });
// Where the harness puts CLAUDE.md and the memory index: an `instructions` attachment, and a leading `<system-reminder>` of a user message.
const instructions = (session: string): string =>
  line({ type: 'attachment', uuid: `${session}-i`, parentUuid: null, timestamp: at(0), version: '2.1.300', sessionId: session, attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', kind: 'Project', content: `# Rules\n${CLAUDE_MD_LINE}\n` }, { path: 'memory/MEMORY.md', kind: 'AutoMem', content: `- ${MEMORY_LINE}\n` }] } });
const reminded = (session: string, n: number): string => user(session, n, `<system-reminder>\nContents of CLAUDE.md:\n${CLAUDE_MD_LINE}\n# memory index\n${MEMORY_LINE}\n</system-reminder>\n${USER_TEXT}`);

interface Fixture {
  root: string;
  runtime: SessionsRuntime;
  terms: string;
  owners: string;
  indexKey: string;
  out: string;
  write: (project: string, session: string, lines: readonly string[], agent?: string) => string;
}

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-sample-pack-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  mkdirSync(projectsRoot);
  const terms = join(root, 'terms.txt');
  writeFileSync(terms, `${TERM}\n`);
  const owners = join(root, 'owners.json');
  writeFileSync(owners, JSON.stringify(OWNERS));
  const indexKey = join(root, 'index.key');
  writeFileSync(indexKey, 'ab'.repeat(32));
  const write = (project: string, session: string, lines: readonly string[], agent?: string): string => {
    const file = agent === undefined ? join(projectsRoot, project, `${session}.jsonl`) : join(projectsRoot, project, session, 'subagents', `${agent}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  return { root, runtime, terms, owners, indexKey, out: join(root, 'pack'), write };
};

const options = (f: Fixture, extra: Partial<PackOptions> = {}): PackOptions => ({ terms: f.terms, owners: f.owners, indexKey: f.indexKey, buyerKey: 'sample', out: f.out, size: 25, seed: '1', ...extra });

const stored = async (f: Fixture): Promise<void> => {
  await deposit(f.runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
};

// A row is read back only far enough to know it is one; the assertions below check its fields.
const isRow = (value: unknown): value is ManifestRow => typeof value === 'object' && value !== null && 'matchId' in value;

const manifest = (out: string): ManifestRow[] =>
  readFileSync(join(out, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter((row) => row !== '')
    .map((row): ManifestRow => {
      const value: unknown = JSON.parse(row);
      if (!isRow(value)) throw new Error('a manifest row with no matchId');
      return value;
    });

const packText = (out: string): string =>
  readdirSync(join(out, 'sessions'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');

describe('the exclusion gate (A38), applied first', () => {
  it('leaves out a session whose subagent transcript holds a term, and one with no raw to scan', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    f.write('-work-oars', S(2), [user(S(2), 1, 'run the build'), assistant(S(2), 1, 'green')]);
    f.write('-work-oars', S(2), [user(S(2), 3, 'look around'), assistant(S(2), 3, `found ${TERM.toUpperCase()} in a log`)], 'agent-a1');
    const gone = f.write('-work-oars', S(3), [user(S(3), 1, 'tidy the docs'), assistant(S(3), 1, 'tidied')]);
    await stored(f);
    // The session is in the store, but neither the harness folder nor oars' raw archive holds its transcript any longer.
    rmSync(gone);
    rmSync(join(paths(f.runtime.storeDir).raw, '-work-oars', `${S(3)}.jsonl`));

    const counts = await buildPack(f.runtime, options(f));

    expect(counts).toMatchObject({ scanned: 3, excluded: { term: 1, noRaw: 1, noTerms: 0, unreadable: 0 }, emitted: 1 });
    expect(manifest(f.out).map((row) => row.session)).toEqual([S(1)]);
  });

  it('emits nothing when the term file is missing (fail closed)', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    rmSync(f.terms);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ excluded: { noTerms: 1 }, emitted: 0 });
  });
});

describe('what is stripped', () => {
  it('drops CLAUDE.md and the memory index from where the harness injects them, and keeps what the person typed', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [instructions(S(1)), reminded(S(1), 1), assistant(S(1), 1, 'renamed it')]);
    await stored(f);
    expect((await buildPack(f.runtime, options(f))).emitted).toBe(1);
    const text = packText(f.out);
    expect(text).not.toContain(CLAUDE_MD_LINE);
    expect(text).not.toContain(MEMORY_LINE);
    expect(text).toContain(USER_TEXT);
    expect(text).toContain('renamed it');
    expect(text).toMatch(/\[injected instructions [0-9a-f]{12}\]/);
  });
});

describe('the manifest', () => {
  it('writes one row per session with its rights and provenance, and leaves out a folder no owner entry names', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    f.write('-work-shop-web', S(2), [user(S(2), 1, 'fix the page'), assistant(S(2), 1, 'fixed')]);
    f.write('-tmp-scratch', S(3), [user(S(3), 1, 'try this'), assistant(S(3), 1, 'tried')]);
    await stored(f);
    const counts = await buildPack(f.runtime, options(f));
    expect(counts).toMatchObject({ scanned: 3, noOwner: 1, emitted: 2 });
    const rows = manifest(f.out).sort((a, b) => (a.session < b.session ? -1 : 1));
    expect(rows.map((row) => [row.session, row.repoOwner, row.sourceLicense])).toEqual([
      [S(1), 'Many Oars Co.', 'Apache-2.0'],
      [S(2), 'Switchyard Software Company', null],
    ]);
    expect(rows[0]).toMatchObject({ harness: 'claude-code', harnessVersions: ['2.1.300'], permittedUses: ['evaluation', 'benchmarking', 'task-design'], training: 'not-offered', transcripts: 1 });
    expect(rows[0]?.harnessTerms.map((terms) => terms.name)).toEqual(['Anthropic Consumer Terms', 'Anthropic Usage Policy']);
    expect(rows[0]?.matchId).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(f.out, 'sessions'))).toEqual(expect.arrayContaining(rows.map((row) => row.matchId)));
  });

  it('gives a session a different match id under each buyer key, and the same one on every run under one key', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const idUnder = async (buyerKey: string, out: string): Promise<string> => {
      await buildPack(f.runtime, options(f, { buyerKey, out: join(f.root, out) }));
      return manifest(join(f.root, out))[0]?.matchId ?? '';
    };
    const first = await idUnder('buyer-a', 'a1');
    expect(await idUnder('buyer-a', 'a2')).toBe(first);
    expect(await idUnder('buyer-b', 'b1')).not.toBe(first);
    const key = readFileSync(f.indexKey, 'utf8');
    expect(first).toBe(matchIdOf('buyer-a', serverKeyOf(key, S(1))));
  });
});

describe('owners file', () => {
  it('matches a folder by its glob, first entry first, without regard to case', () => {
    const rules = parseOwners(JSON.stringify(OWNERS));
    expect(ownerOf(rules, 'C--Users-x-OARS')?.owner).toBe('Many Oars Co.');
    expect(ownerOf(rules, '-work-shop-oars')?.owner).toBe('Many Oars Co.');
    expect(ownerOf(rules, '-tmp-scratch')).toBeUndefined();
  });

  it('refuses an entry with no owner', () => {
    expect(() => parseOwners(JSON.stringify([{ folder: '*', owner: '', license: null }]))).toThrow(/owner/);
  });
});

describe('the command line', () => {
  it('refuses an output folder that is not empty, and says why', async () => {
    const f = fixture();
    mkdirSync(f.out);
    writeFileSync(join(f.out, 'old.txt'), 'x');
    const printed: string[] = [];
    const code = await main(['--terms', f.terms, '--owners', f.owners, '--index-key', f.indexKey, '--buyer-key', 'sample', '--out', f.out], { runtime: f.runtime, print: (text) => printed.push(text) });
    expect(code).toBe(2);
    expect(printed.join('\n')).toMatch(/not empty/);
  });

  it('refuses an output folder inside a git repository, since a pack is never committed', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'repo', '.git'), { recursive: true });
    const printed: string[] = [];
    const out = join(f.root, 'repo', 'packs', 'one');
    const code = await main(['--terms', f.terms, '--owners', f.owners, '--index-key', f.indexKey, '--buyer-key', 'sample', '--out', out], { runtime: f.runtime, print: (text) => printed.push(text) });
    expect(code).toBe(2);
    expect(printed.join('\n')).toMatch(/inside a git repository/);
  });

  it('prints the usage when a required option is missing', async () => {
    const f = fixture();
    const printed: string[] = [];
    expect(await main(['--terms', f.terms], { runtime: f.runtime, print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toContain(USAGE);
  });
});
