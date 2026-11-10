// The first sale's sample pack (P98 (10) to (12)): fixture stores, built in a temp folder, with an invented term and invented instruction text.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deposit, loadStore, paths, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { rolloutLine, stageCodex } from '../../cli/src/sessions/test-support.js';
import { buildPack, main, matchIdOf, ownerOf, parseOwners, secretIn, serverKeyOf, USAGE, type ManifestRow, type PackOptions } from './sample-pack.js';

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
// Ids shaped as the harness writes them: a uuid per line, `parentUuid` naming the line before, and a `req_` id per request.
const uuidOf = (session: string, kind: 'a' | 'b', n: number): string => `${session.slice(0, 8)}-${kind}${String(n).padStart(3, '0')}-4222-8222-222222222222`;
const requestOf = (session: string, n: number): string => `req_011C${session.slice(0, 8)}x${String(n)}`;
// The working directory of a fixture's sessions: a folder with an origin remote, so the store records a repository for them. `fixture()` sets it.
let repoCwd = '';
const user = (session: string, n: number, content: string, cwd = repoCwd): string =>
  line({ type: 'user', uuid: uuidOf(session, 'b', n), parentUuid: null, isSidechain: false, timestamp: at(n), version: '2.1.300', sessionId: session, cwd, message: { role: 'user', content } });
const assistant = (session: string, n: number, text: string): string =>
  line({ type: 'assistant', uuid: uuidOf(session, 'a', n), parentUuid: uuidOf(session, 'b', n), isSidechain: false, timestamp: at(n + 1), version: '2.1.300', sessionId: session, requestId: requestOf(session, n), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } } });
// Where the harness puts CLAUDE.md and the memory index: an `instructions` attachment, and a leading `<system-reminder>` of a user message.
const instructions = (session: string): string =>
  line({ type: 'attachment', uuid: uuidOf(session, 'a', 999), parentUuid: null, timestamp: at(0), version: '2.1.300', sessionId: session, attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', kind: 'Project', content: `# Rules\n${CLAUDE_MD_LINE}\n` }, { path: 'memory/MEMORY.md', kind: 'AutoMem', content: `- ${MEMORY_LINE}\n` }] } });
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
  repoCwd = join(root, 'work', 'app');
  mkdirSync(join(repoCwd, '.git'), { recursive: true });
  writeFileSync(join(repoCwd, '.git', 'config'), `[remote "origin"]\n\turl = https://example.com/acme/app.git\n`);
  mkdirSync(join(root, 'notes'));
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

const options = (f: Fixture, extra: Partial<PackOptions> = {}): PackOptions => ({ terms: f.terms, owners: f.owners, indexKey: f.indexKey, buyerKey: 'sample', out: f.out, size: 25, seed: '1', minTurns: 1, ...extra });

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

const packFiles = (out: string): string[] =>
  readdirSync(join(out, 'sessions'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

const packText = (out: string): string => packFiles(out).map((file) => readFileSync(file, 'utf8')).join('\n');

interface IndexRow {
  pack: string;
  session: string;
  matchId: string;
}

const isIndexRow = (value: unknown): value is IndexRow => typeof value === 'object' && value !== null && 'session' in value && 'matchId' in value;

// The operator's index, beside the owners file: the only place a session id meets its match id.
const indexOf = (f: Fixture): IndexRow[] =>
  readFileSync(join(f.root, 'index.jsonl'), 'utf8')
    .split('\n')
    .filter((row) => row !== '')
    .map((row): IndexRow => {
      const value: unknown = JSON.parse(row);
      if (!isIndexRow(value)) throw new Error('an index row with no session');
      return value;
    });

/** The session each manifest row stands for, read through the operator's index. */
const sessionsOf = (f: Fixture, out = f.out): string[] => {
  const byMatch = new Map(indexOf(f).map((row) => [row.matchId, row.session]));
  return manifest(out).map((row) => byMatch.get(row.matchId) ?? '');
};

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
    expect(sessionsOf(f)).toEqual([S(1)]);
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
    const sessions = sessionsOf(f);
    const rows = manifest(f.out)
      .map((row, at) => ({ ...row, session: sessions[at] ?? '' }))
      .sort((a, b) => (a.session < b.session ? -1 : 1));
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

  it('refuses an owners folder inside a git repository, since the operator index lands beside it, and writes nothing', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'repo', '.git'), { recursive: true });
    const owners = join(f.root, 'repo', 'owners.json');
    writeFileSync(owners, JSON.stringify(OWNERS));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const printed: string[] = [];
    const code = await main(['--terms', f.terms, '--owners', owners, '--index-key', f.indexKey, '--buyer-key', 'sample', '--out', f.out], { runtime: f.runtime, print: (text) => printed.push(text) });
    expect(code).toBe(2);
    expect(printed.join('\n')).toMatch(/owners file.*inside a git repository/);
    expect(existsSync(join(f.root, 'repo', 'index.jsonl'))).toBe(false);
    expect(existsSync(f.out)).toBe(false);
    expect(existsSync(`${f.out}.partial`)).toBe(false);
  });

  it('prints the usage when a required option is missing', async () => {
    const f = fixture();
    const printed: string[] = [];
    expect(await main(['--terms', f.terms], { runtime: f.runtime, print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toContain(USAGE);
  });
});

describe('what a buyer can join on', () => {
  it('keeps every session id, line uuid, and request id out of the pack, and the index beside the owners file maps the session', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done'), user(S(1), 2, `resume ${S(2)} later`)]);
    f.write('-work-oars', S(1), [user(S(1), 3, 'look around'), assistant(S(1), 3, 'looked')], 'agent-a1');
    f.write('-work-oars', S(2), [user(S(2), 1, 'run the build'), assistant(S(2), 1, 'green')]);
    await stored(f);
    expect((await buildPack(f.runtime, options(f))).emitted).toBe(2);
    const raw = [S(1), S(2), uuidOf(S(1), 'b', 1), uuidOf(S(1), 'a', 1), uuidOf(S(1), 'a', 3), uuidOf(S(1), 'b', 3), uuidOf(S(2), 'b', 1), uuidOf(S(2), 'a', 1), requestOf(S(1), 1), requestOf(S(1), 3), requestOf(S(2), 1)];
    for (const file of [join(f.out, 'manifest.jsonl'), join(f.out, 'pack.json'), ...packFiles(f.out)]) {
      const text = readFileSync(file, 'utf8');
      for (const id of raw) expect(text, `${id} in ${file}`).not.toContain(id);
    }
    const index = indexOf(f);
    expect(index.map((row) => row.session).sort()).toEqual([S(1), S(2)]);
    expect(index.every((row) => row.pack === f.out)).toBe(true);
    const matchId = index.find((row) => row.session === S(1))?.matchId ?? '';
    const lines = readFileSync(join(f.out, 'sessions', matchId, 'main.jsonl'), 'utf8')
      .split('\n')
      .filter((text) => text !== '')
      .map((text): unknown => JSON.parse(text));
    const field = (entry: unknown, name: string): unknown => (typeof entry === 'object' && entry !== null ? Reflect.get(entry, name) : undefined);
    // Each line names the session by its match id, and the masked parent still names the masked line before it.
    expect(lines.map((entry) => field(entry, 'sessionId'))).toEqual([matchId, matchId, matchId]);
    expect(field(lines[1], 'parentUuid')).toBe(field(lines[0], 'uuid'));
    expect(field(lines[0], 'uuid')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(field(lines[1], 'requestId')).toMatch(/^req_[0-9a-f]{24}$/);
    // Another session the text names is masked to that session's own match id, so the buyer sees the link but not the id.
    expect(JSON.stringify(lines[2])).toContain(index.find((row) => row.session === S(2))?.matchId ?? 'none');
  });
});

describe('the acceptance rule (plan S1)', () => {
  const turns = (session: string, count: number): string[] => Array.from({ length: count }, (_, n) => [user(session, 2 * n + 1, `ask ${String(n)}`), assistant(session, 2 * n + 1, `answer ${String(n)}`)]).flat();

  it('keeps a subagent transcript out of the frame: only the main session is drawn', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), turns(S(1), 1));
    f.write('-work-oars', S(1), [user(S(1), 9, 'look around'), assistant(S(1), 9, 'looked')], 'agent-a1');
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ frame: 1, scanned: 1, emitted: 1 });
  });

  it('drops a session under --min-turns (user plus assistant turns) and counts it, and the default is 20', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), turns(S(1), 2));
    f.write('-work-oars', S(2), turns(S(2), 1));
    await stored(f);
    expect(await buildPack(f.runtime, options(f, { minTurns: 4 }))).toMatchObject({ tooShort: 1, noRepo: 0, duplicate: 0, emitted: 1 });
    expect(sessionsOf(f)).toEqual([S(1)]);
    const printed: string[] = [];
    const out = join(f.root, 'default');
    const code = await main(['--terms', f.terms, '--owners', f.owners, '--index-key', f.indexKey, '--buyer-key', 'sample', '--out', out], { runtime: f.runtime, print: (text) => printed.push(text) });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'pack.json'), 'utf8'))).toMatchObject({ minTurns: 20, counts: { tooShort: 2, emitted: 0 } });
    expect(printed.join('\n')).toContain('2 under 20 turns');
  });

  it('refuses a --min-turns that is not a whole number of 1 or more', async () => {
    const f = fixture();
    const printed: string[] = [];
    const code = await main(['--terms', f.terms, '--owners', f.owners, '--index-key', f.indexKey, '--buyer-key', 'sample', '--out', f.out, '--min-turns', '0'], { runtime: f.runtime, print: (text) => printed.push(text) });
    expect(code).toBe(2);
    expect(printed.join('\n')).toContain('--min-turns takes a whole number');
  });

  it('drops a session with no repository and counts it', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), turns(S(1), 1));
    f.write('-work-oars', S(2), [user(S(2), 1, 'tidy these notes', join(f.root, 'notes')), assistant(S(2), 1, 'tidied')]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ noRepo: 1, tooShort: 0, emitted: 1 });
    expect(sessionsOf(f)).toEqual([S(1)]);
  });

  it('drops a resumed session that replays an earlier one in favor of the longer, whichever is drawn first', async () => {
    const f = fixture();
    const earlier = turns(S(1), 2);
    // A resumed session starts with the earlier one's lines (same uuids, its own session id), then goes on.
    const replay = earlier.map((text) => line({ ...JSON.parse(text), sessionId: S(2) }));
    f.write('-work-oars', S(1), earlier);
    f.write('-work-oars', S(2), [...replay, ...turns(S(2), 2)]);
    f.write('-work-oars', S(3), turns(S(3), 2));
    await stored(f);
    for (const seed of ['1', '2', '3', '4']) {
      const out = join(f.root, `pack-${seed}`);
      expect(await buildPack(f.runtime, options(f, { seed, out }))).toMatchObject({ duplicate: 1, emitted: 2 });
      expect(sessionsOf(f, out).sort()).toEqual([S(2), S(3)]);
    }
  });
});

describe('the run record', () => {
  it('writes how long the run took and how many bytes the pack holds (sessions and manifest) into pack.json', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    const pack: unknown = JSON.parse(readFileSync(join(f.out, 'pack.json'), 'utf8'));
    const field = (name: string): unknown => (typeof pack === 'object' && pack !== null ? Reflect.get(pack, name) : undefined);
    const held = [...packFiles(f.out), join(f.out, 'manifest.jsonl')].reduce((sum, file) => sum + statSync(file).size, 0);
    expect(field('bytes')).toBe(held);
    expect(held).toBeGreaterThan(0);
    const elapsed = field('elapsedMs');
    expect(typeof elapsed === 'number' && Number.isInteger(elapsed) && elapsed >= 0).toBe(true);
  });
});

describe('the secret scan', () => {
  // Built from parts so this file holds no whole key shape for a scanner to find.
  const SHAPES: [string, string][] = [
    ['private key', '-----BEGIN RSA PRIVATE ' + 'KEY-----'],
    ['AWS access key id', 'AK' + 'IA' + 'IOSFODNN7EXAMPLE'],
    ['GitHub token', 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'],
    ['GitHub fine-grained token', 'github_' + 'pat_' + '11AAAAAAA0abcdefghij1234'],
    ['API key', 'sk' + '-ant-' + 'api03abcdefghij1234567890'],
    ['Stripe key', 'sk' + '_live_' + 'abcdefghij1234'],
    ['Stripe webhook secret', 'wh' + 'sec_' + 'abcdefghij1234'],
    ['Slack token', 'xo' + 'xb-' + '1234567890-abcdefghij'],
    ['Google API key', 'AI' + 'za' + 'SyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'],
    ['JSON web token', 'ey' + 'J' + 'hbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'],
    ['password in a URL', 'https://admin:hunter22' + '@example.com/repo'],
  ];

  it.each(SHAPES)('finds a %s in a text, even stuck to the word before it', (name, sample) => {
    expect(secretIn(`the value is ${sample} here`)).toBe(name);
    expect(secretIn(`prefix${sample}`)).toBe(name);
  });

  it('passes ordinary text, a masked value, kebab-case words, and a masked URL', () => {
    for (const text of ['please rename the helper in parse.ts', 'token=<secret>', 'https://<secret>@example.com', 'the task-management-and-planning-notes and a disk-usage-report-for-the-quarter', 'Bearer <secret>']) expect(secretIn(text)).toBeUndefined();
  });

  it('drops a session whose redacted text still holds a key, writes nothing of it, and counts it', async () => {
    const f = fixture();
    // Stuck to a word, the key is outside the redactor's word-boundary rule: it comes through redaction, and the scan is what stops it.
    const planted = 'my' + 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, `set it to ${planted} and rerun`)]);
    f.write('-work-oars', S(2), [user(S(2), 1, 'run the build'), assistant(S(2), 1, 'green')]);
    await stored(f);
    const counts = await buildPack(f.runtime, options(f));
    expect(counts).toMatchObject({ scanned: 2, secret: 1, emitted: 1 });
    expect(sessionsOf(f)).toEqual([S(2)]);
    expect(packText(f.out)).not.toContain(planted);
    expect(readFileSync(join(f.out, 'manifest.jsonl'), 'utf8')).not.toContain(planted);
    expect(indexOf(f).map((row) => row.session)).toEqual([S(2)]);
    expect(readdirSync(join(f.out, 'sessions'))).toHaveLength(1);
  });
});

describe('the harness terms gate', () => {
  it('leaves out a session from a harness with no terms row, after the exclusion gate has cleared it', async () => {
    const f = fixture();
    const id = 'cccc3333-3333-4333-8333-333333333333';
    const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
    const rollout = [
      rolloutLine(T(0), 'session_meta', { session_id: id, id, timestamp: T(0), cwd: join(f.root, 'not-a-repo'), originator: 'codex_cli_rs', cli_version: '0.50.0' }),
      rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: join(f.root, 'not-a-repo') }),
      rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'fix the build' }),
      rolloutLine(T(3), 'event_msg', { type: 'agent_message', message: 'fixed' }),
    ];
    const home = stageCodex(f.root, [{ id, lines: rollout }]);
    // The fixture runtime names no sources, which reads none; this one reads Codex's.
    const { storeDir, projectsRoot, stdin, stdout } = f.runtime;
    await deposit({ storeDir, projectsRoot, stdin, stdout, sourceRoots: { codex: home } }, { allow: ['codex'], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
    const record = (await loadStore(f.runtime.storeDir)).sessions.find((session) => session.harness === 'codex');
    if (record === undefined) throw new Error('the rollout did not reach the store');
    // A raw copy where the gate looks, so the exclusion gate clears the session and the harness gate is what decides.
    f.write(record.project, record.session, rollout.map((entry) => JSON.stringify(entry)));
    const owners = join(f.root, 'owners-all.json');
    writeFileSync(owners, JSON.stringify([{ folder: '*', owner: 'Many Oars Co.', license: null }]));
    expect(await buildPack(f.runtime, options(f, { owners }))).toMatchObject({ scanned: 1, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, noOwner: 0, noHarnessTerms: 1, emitted: 0 });
    expect(existsSync(join(f.out, 'sessions'))).toBe(false);
    expect(manifest(f.out)).toEqual([]);
  });
});

describe('refusals and an unfinished run', () => {
  const run = async (f: Fixture, extra: readonly string[] = []): Promise<{ code: number; printed: string }> => {
    const printed: string[] = [];
    const args = ['--terms', f.terms, '--owners', f.owners, '--index-key', f.indexKey, '--buyer-key', 'sample', '--out', f.out, '--min-turns', '1', ...extra];
    const code = await main(args, { runtime: f.runtime, print: (text) => printed.push(text) });
    return { code, printed: printed.join('\n') };
  };

  it('refuses an index key shorter than 64 hex characters', async () => {
    const f = fixture();
    writeFileSync(f.indexKey, 'ab'.repeat(31));
    const { code, printed } = await run(f);
    expect(code).toBe(2);
    expect(printed).toContain('64 or more hex');
  });

  it('refuses an owners file that is not JSON', async () => {
    const f = fixture();
    writeFileSync(f.owners, '{');
    expect((await run(f)).code).toBe(2);
    expect(existsSync(f.out)).toBe(false);
  });

  it('leaves no pack under the output folder when the run stops partway, and refuses to build over the unfinished one', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    // The index cannot be written (a folder holds its name), so the run fails after the sessions are copied.
    mkdirSync(join(f.root, 'index.jsonl'));
    await expect(buildPack(f.runtime, options(f))).rejects.toThrow();
    expect(existsSync(f.out)).toBe(false);
    expect(existsSync(`${f.out}.partial`)).toBe(true);
    rmSync(join(f.root, 'index.jsonl'), { recursive: true });
    const refused = await run(f);
    expect(refused.code).toBe(2);
    expect(refused.printed).toContain('.partial');
    rmSync(`${f.out}.partial`, { recursive: true });
    mkdirSync(f.out);
    expect((await run(f)).code).toBe(0);
    expect(existsSync(`${f.out}.partial`)).toBe(false);
    expect(manifest(f.out)).toHaveLength(1);
  });
});
