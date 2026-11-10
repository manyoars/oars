// The first sale's sample pack (P98 (10) to (12)): fixture stores, built in a temp folder, with an invented term and invented instruction text.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Exclusion from '../../cli/src/sessions/exclusion.js';
import { SKELETON_FORMAT, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { deposit, loadStore, paths, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { runGit } from '../../cli/src/sessions/survival.js';
import { rolloutLine, stageCodex } from '../../cli/src/sessions/test-support.js';
import { buildPack, HARNESS_TERMS, main, matchIdOf, ownerOf, parseOwners, secretIn, serverKeyOf, skeletonUnder, USAGE, type Census, type ManifestRow, type PackCounts, type PackOptions, type Tally } from './sample-pack.js';

// Every session the exclusion check was asked about, in call order: the frame-first rule is proved by who was never asked.
const gated = vi.hoisted((): string[] => []);
vi.mock('../../cli/src/sessions/exclusion.js', async (original) => {
  const real = await original<typeof Exclusion>();
  return { ...real, checkSession: async (...args: Parameters<typeof real.checkSession>): Promise<Awaited<ReturnType<typeof real.checkSession>>> => {
    gated.push(args[3]);
    return real.checkSession(...args);
  } };
});

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
const user = (session: string, n: number, content: string, cwd = repoCwd, gitBranch?: string): string =>
  line({ type: 'user', uuid: uuidOf(session, 'b', n), parentUuid: null, isSidechain: false, timestamp: at(n), version: '2.1.300', sessionId: session, cwd, ...(gitBranch === undefined ? {} : { gitBranch }), message: { role: 'user', content } });
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

// The harness's own lines alone, one JSON value per line: a session's skeleton is a JSON document beside them.
const transcriptText = (out: string): string => packFiles(out).filter((file) => !file.endsWith('skeleton.json')).map((file) => readFileSync(file, 'utf8')).join('\n');

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
    expect(rows[0]?.harnessTerms).toEqual([
      { name: 'Anthropic Consumer Terms', version: 'effective 2025-10-08' },
      { name: 'Anthropic Usage Policy', version: 'effective 2026-11-12' },
    ]);
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

describe('the skeleton and the manifest fields it adds (plan S3)', () => {
  it('writes skeleton.json beside each session, and gives its manifest row models, turns, and the skeleton name', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done'), user(S(1), 3, 'and another'), assistant(S(1), 3, 'done too')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    const [row] = manifest(f.out);
    expect(row).toMatchObject({ models: { 'claude-opus-5-5': 2 }, turns: 4, skeleton: 'skeleton.json' });
    expect(existsSync(join(f.out, 'sessions', row?.matchId ?? '', 'skeleton.json'))).toBe(true);
  });

  const isCensus = (value: unknown): value is Census => typeof value === 'object' && value !== null && 'sessions' in value && 'harness' in value && 'turnBucket' in value;
  const readCensus = (out: string): Census => {
    const value: unknown = JSON.parse(readFileSync(join(out, 'census.json'), 'utf8'));
    if (!isCensus(value)) throw new Error('a census with no sessions');
    return value;
  };

  const skeletonText = (out: string, matchId: string): string => readFileSync(join(out, 'sessions', matchId, 'skeleton.json'), 'utf8');
  const repoKeysIn = (text: string): string[] => [...text.matchAll(/"repoKey": "([0-9a-f]{16})"/g)].map((found) => found[1] ?? '');

  it('names the skeleton by the match id and holds no store repoKey or session id; two buyer keys give two repoKeys', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const [held] = (await loadStore(f.runtime.storeDir)).sessions;
    const storeKey = held?.repo ?? '';
    expect(storeKey).toMatch(/^[0-9a-f]{16}$/);
    const under = async (buyerKey: string, out: string): Promise<{ text: string; matchId: string; all: string }> => {
      await buildPack(f.runtime, options(f, { buyerKey, out: join(f.root, out) }));
      const matchId = manifest(join(f.root, out))[0]?.matchId ?? '';
      return { text: skeletonText(join(f.root, out), matchId), matchId, all: packText(join(f.root, out)) };
    };
    const a = await under('buyer-a', 'a');
    const b = await under('buyer-b', 'b');
    for (const pack of [a, b]) {
      expect(pack.all).not.toContain(storeKey);
      expect(pack.all).not.toContain(S(1));
      expect(JSON.parse(pack.text)).toMatchObject({ id: pack.matchId });
    }
    // Non-vacuous: the fixture's skeleton does carry a repoKey, and each buyer's differs from the store's and from the other's. One buyer sees one repository as one key.
    const keysA = repoKeysIn(a.text);
    const keysB = repoKeysIn(b.text);
    expect(keysA.length).toBeGreaterThan(0);
    expect(new Set(keysA).size).toBe(1);
    expect(keysA[0]).not.toBe(storeKey);
    expect(keysB[0]).not.toBe(keysA[0]);
    expect(a.matchId).not.toBe(b.matchId);
  });

  it('ships no unkeyed hash of content or timing: no digests, and the root and print differ per buyer', async () => {
    const f = fixture();
    const oldText = 'const owner = "jane.doe@example.com";';
    const newText = 'const owner = "someone";';
    const edit = (n: number): string =>
      line({ type: 'assistant', uuid: uuidOf(S(1), 'a', n), parentUuid: uuidOf(S(1), 'b', n), isSidechain: false, timestamp: at(n + 1), version: '2.1.300', sessionId: S(1), requestId: requestOf(S(1), n), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_01edit${String(n)}`, name: 'Edit', input: { file_path: 'src/owner.ts', old_string: oldText, new_string: newText } }], usage: { input_tokens: 10, output_tokens: 20 } } });
    const result = (n: number): string =>
      line({ type: 'user', uuid: uuidOf(S(1), 'b', n + 1), parentUuid: uuidOf(S(1), 'a', n), isSidechain: false, timestamp: at(n + 2), version: '2.1.300', sessionId: S(1), cwd: repoCwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_01edit${String(n)}`, content: 'edited' }] } });
    f.write('-work-oars', S(1), [user(S(1), 1, 'rename the owner'), edit(2), result(2), edit(5), result(5), edit(8), result(8), assistant(S(1), 10, 'done')]);
    await stored(f);
    const under = async (buyerKey: string, out: string): Promise<{ text: string; all: string }> => {
      await buildPack(f.runtime, options(f, { buyerKey, out: join(f.root, out) }));
      const matchId = manifest(join(f.root, out))[0]?.matchId ?? '';
      return { text: skeletonText(join(f.root, out), matchId), all: packText(join(f.root, out)) };
    };
    const a = await under('buyer-a', 'a');
    const b = await under('buyer-b', 'b');
    // Non-vacuous: the fixture's tools are in the skeleton, and the wire does hold a root for each buyer.
    expect(a.text).toContain('"Edit"');
    const shaped = (text: string): string[] => [...text.matchAll(/[0-9a-f]{64}/g)].map((found) => found[0]);
    expect(shaped(a.text).length).toBeGreaterThan(0);
    expect(shaped(a.text).filter((value) => shaped(b.text).includes(value))).toEqual([]);
    // Neither the digests field nor the digest of any edit text, whole or at the wire's 32 digits, is anywhere in the pack.
    expect(a.text).not.toContain('digests');
    for (const text of [oldText, newText]) {
      const full = createHash('sha256').update(text).digest('hex');
      expect(a.all).not.toContain(full.slice(0, 32));
      expect(b.all).not.toContain(full.slice(0, 32));
    }
    const prints = (text: string): string[] => [...text.matchAll(/"timingPrint": "([0-9a-f]{16})"/g)].map((found) => found[1] ?? '');
    expect(prints(a.text).filter((value) => prints(b.text).includes(value))).toEqual([]);
  });

  it('re-derives the batch timing print under each buyer key, in 16 hex, and leaves an absent print absent', () => {
    const print = '0123456789abcdef';
    const skeleton = (timingPrint: string | null): SessionSkeleton => ({ format: SKELETON_FORMAT, vocabVersion: 'v', fieldsVersion: 1, id: 'store-id', transcripts: [], timingPrint, deltas: [] });
    const a = skeletonUnder(skeleton(print), 'match', 'buyer-a').timingPrint;
    const b = skeletonUnder(skeleton(print), 'match', 'buyer-b').timingPrint;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(print);
    expect(a).not.toBe(b);
    expect(skeletonUnder(skeleton(print), 'match', 'buyer-a').timingPrint).toBe(a);
    expect(skeletonUnder(skeleton(null), 'match', 'buyer-a').timingPrint).toBeNull();
  });

  it('counts a session whose store holds no skeleton, and writes nothing of it', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    // The skeleton files hold each transcript's root; without one the wire builds no batch.
    rmSync(paths(f.runtime.storeDir).skeletons, { recursive: true, force: true });
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ emitted: 0, noSkeleton: 1 });
    expect(manifest(f.out)).toEqual([]);
    expect(existsSync(join(f.out, 'sessions'))).toBe(false);
  });

  it('writes census.json from the same skeletons: counts only, totals equal to the manifest, and no match id or session id', async () => {
    const f = fixture();
    const failing = [
      user(S(1), 1, 'run the build'),
      line({ type: 'assistant', uuid: uuidOf(S(1), 'a', 1), parentUuid: uuidOf(S(1), 'b', 1), isSidechain: false, timestamp: at(2), version: '2.1.300', sessionId: S(1), requestId: requestOf(S(1), 1), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_01build', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 10, output_tokens: 20 } } }),
      line({ type: 'user', uuid: uuidOf(S(1), 'b', 3), parentUuid: uuidOf(S(1), 'a', 1), isSidechain: false, timestamp: at(3), version: '2.1.300', sessionId: S(1), cwd: repoCwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01build', is_error: true, content: 'Error: Exit code 1' }] } }),
      assistant(S(1), 4, 'it failed'),
    ];
    f.write('-work-oars', S(1), failing);
    f.write('-work-shop-web', S(2), [user(S(2), 1, 'fix the page'), assistant(S(2), 1, 'fixed')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    const rows = manifest(f.out);
    const census = readCensus(f.out);
    const total = (tally: Tally): number => Object.values(tally).reduce((sum, count) => sum + count, 0);
    expect(census.sessions).toBe(rows.length);
    expect(total(census.harness)).toBe(rows.length);
    expect(census.harness).toEqual({ 'claude-code': 2 });
    expect(census.harnessVersion).toEqual({ '2.1.300': 2 });
    expect(total(census.turnBucket)).toBe(rows.length);
    expect(total(census.model)).toBe(rows.reduce((sum, row) => sum + total(row.models), 0));
    // Every failed call a skeleton holds is counted once, and the fixture holds one.
    const failed = rows.flatMap((row) => skeletonText(f.out, row.matchId).match(/"errorCode": "[^"]+"/g) ?? []);
    expect(failed.length).toBeGreaterThan(0);
    expect(total(census.errorCode)).toBe(failed.length);
    expect(total(census.recovery)).toBe(failed.length);
    expect(total(census.promptClass)).toBeGreaterThanOrEqual(rows.length);
    const text = readFileSync(join(f.out, 'census.json'), 'utf8');
    for (const row of rows) expect(text).not.toContain(row.matchId);
    for (const session of [S(1), S(2)]) expect(text).not.toContain(session);
  });
});

// Each of these runs several real git processes, and a Windows runner spends seconds on them.
describe('the repository pointer and the outcome (plan S4)', { timeout: 30_000 }, () => {
  const REMOTE = 'https://example.com/acme/app.git';
  const OPTED_IN = [{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0', pointer: true }];

  // A real repository in the fixture's temp folder; git is never run against the oars checkout. Commit dates are fixed so `--before` has something to order.
  const git = (repo: string, args: readonly string[], when = '2026-05-20T12:00:00Z'): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } }).trim();

  const commitIn = (repo: string, name: string, when: string): string => {
    writeFileSync(join(repo, name), `${name}\n`);
    git(repo, ['add', name]);
    git(repo, ['commit', '-m', name], when);
    return git(repo, ['rev-parse', 'HEAD']);
  };

  interface Shas {
    base: string;
    onMain: string;
    onFeature: string;
  }

  // `main` is checked out and is the remote's default branch; `feature` holds one more, newer commit. A session on `feature` that read HEAD would get the wrong one.
  const makeRepo = (repo: string): Shas => {
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['remote', 'add', 'origin', REMOTE]);
    const base = commitIn(repo, 'base.txt', '2026-05-01T12:00:00Z');
    const onMain = commitIn(repo, 'main.txt', '2026-05-20T12:00:00Z');
    git(repo, ['checkout', '-q', '-b', 'feature']);
    const onFeature = commitIn(repo, 'feature.txt', '2026-05-25T12:00:00Z');
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', onMain]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    return { base, onMain, onFeature };
  };

  const pointerOf = (row: ManifestRow | undefined): unknown => (row === undefined ? undefined : Reflect.get(row, 'pointer'));

  it('gives a session on a branch that is not checked out the newest commit of its own branch before it started, not HEAD', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    // A commit on the session's own branch dated after it started: the cutoff must keep it out.
    git(repo, ['checkout', '-q', 'feature']);
    commitIn(repo, 'after-start.txt', '2026-06-03T12:00:00Z');
    git(repo, ['checkout', '-q', 'main']);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toMatchObject({ remote: REMOTE, commit: shas.onFeature });
  });

  it('falls back to origin/<branch> when the local branch is gone, then to origin/HEAD with the same cutoff, and never reads a commit made after the session started', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    git(repo, ['update-ref', 'refs/remotes/origin/topic', shas.onFeature]);
    git(repo, ['branch', '-q', '-D', 'feature']);
    // A commit on main dated after the session began: the cutoff must keep it out.
    // The remote's default branch holds it too, so the origin/HEAD lookup reaches it unless the cutoff stops it.
    git(repo, ['update-ref', 'refs/remotes/origin/main', commitIn(repo, 'later.txt', '2026-06-02T12:00:00Z')]);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'topic'), assistant(S(1), 1, 'done')]);
    f.write('-work-oars', S(2), [user(S(2), 1, 'rename a helper', repo, 'never-pushed'), assistant(S(2), 1, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    const byTurn = new Map(manifest(f.out).map((row) => [row.matchId, pointerOf(row)]));
    expect([...byTurn.values()]).toEqual(expect.arrayContaining([expect.objectContaining({ commit: shas.onFeature }), expect.objectContaining({ commit: shas.onMain })]));
    expect(byTurn.size).toBe(2);
  });

  it('maps a working directory that no longer exists to the repository it was a worktree of', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    const gone = join(repo, '.claude', 'worktrees', 't1');
    mkdirSync(gone, { recursive: true });
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', gone, 'task/t1'), assistant(S(1), 1, 'done')]);
    await stored(f);
    rmSync(join(repo, '.claude'), { recursive: true });
    const counts = await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toEqual({ remote: REMOTE, commit: shas.onMain });
    expect(counts.noPointer).toBe(0);
  });

  it('reads pointer: null for a session whose directory and repository are both gone, and counts it once', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    makeRepo(repo);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    rmSync(repo, { recursive: true, force: true });
    const counts = await buildPack(f.runtime, options(f));
    const [row] = manifest(f.out);
    expect(row).toBeDefined();
    expect(Reflect.get(row ?? {}, 'pointer')).toBeNull();
    expect(counts).toMatchObject({ emitted: 1, noPointer: 1 });
  });

  it('makes no git call, writes no pointer or outcome, and counts no noPointer when no owners entry opts in', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    makeRepo(repo);
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const spy = vi.fn(runGit);
    const counts = await buildPack(f.runtime, options(f, { git: spy }));
    expect(spy).not.toHaveBeenCalled();
    const [row] = manifest(f.out);
    expect(row).toBeDefined();
    expect(row ? Object.keys(row) : []).not.toEqual(expect.arrayContaining(['pointer']));
    expect(row ? Object.keys(row) : []).not.toEqual(expect.arrayContaining(['outcome']));
    expect(counts).toMatchObject({ emitted: 1, noPointer: 0 });
  });

  it('asks the injected runner for the remote of the working directory, and drops credentials embedded in the remote URL', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    git(repo, ['remote', 'set-url', 'origin', 'https://builder:s3cret@example.com/acme/app.git']);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const spy = vi.fn(runGit);
    await buildPack(f.runtime, options(f, { git: spy }));
    expect(spy).toHaveBeenCalledWith(repo, ['remote', 'get-url', 'origin']);
    expect(pointerOf(manifest(f.out)[0])).toEqual({ remote: REMOTE, commit: shas.onFeature });
    expect(readFileSync(join(f.out, 'manifest.jsonl'), 'utf8')).not.toContain('s3cret');
  });

  it('reads pointer: null and counts noPointer once for a repository with no origin', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    makeRepo(repo);
    git(repo, ['remote', 'remove', 'origin']);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const counts = await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toBeNull();
    expect(counts).toMatchObject({ emitted: 1, noPointer: 1 });
  });

  it('never passes a session branch that reads as an option (--all) to rev-list, and still finds the commit through origin/HEAD', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, '--all'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const spy = vi.fn(runGit);
    await buildPack(f.runtime, options(f, { git: spy }));
    const asked = spy.mock.calls.filter(([, args]) => args[0] === 'rev-list');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some(([, args]) => args.includes('--all') || args.includes('origin/--all'))).toBe(false);
    expect(pointerOf(manifest(f.out)[0])).toMatchObject({ commit: shas.onMain });
  });

  it('reads the working directory of a Codex rollout from session_meta.payload.cwd', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    const owners = join(f.root, 'owners-pointer.json');
    writeFileSync(owners, JSON.stringify([{ folder: '*', owner: 'Many Oars Co.', license: null, pointer: true }]));
    const inRepo = codexRollout().map((entry) => {
      const payload: unknown = Reflect.get(entry, 'payload');
      return Reflect.get(entry, 'type') === 'session_meta' && typeof payload === 'object' && payload !== null ? { ...entry, payload: { ...payload, cwd: repo } } : entry;
    });
    const counts = await buildPack(await withCodex(f, inRepo), options(f, { owners }));
    expect(counts).toMatchObject({ emitted: 1, noPointer: 0 });
    expect(pointerOf(manifest(f.out)[0])).toEqual({ remote: REMOTE, commit: shas.onMain });
  });

  it.each([
    ['a local path', (repo: string) => join(repo, '..', 'elsewhere', 'app.git')],
    ['a file: URL', (repo: string) => pathToFileURL(join(repo, '..', 'elsewhere', 'app.git')).href],
    ['a URL that holds a key shape', () => 'https://example.com/acme/' + 'AK' + 'IA' + 'IOSFODNN7EXAMPLE' + '.git'],
  ])('reads pointer: null, counted in noPointer, and writes nothing of the remote for %s', async (_name, remoteOf) => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    makeRepo(repo);
    const remote = remoteOf(repo);
    git(repo, ['remote', 'set-url', 'origin', remote]);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const counts = await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toBeNull();
    expect(counts).toMatchObject({ emitted: 1, noPointer: 1 });
    expect(readFileSync(join(f.out, 'manifest.jsonl'), 'utf8')).not.toContain('elsewhere');
    expect(readFileSync(join(f.out, 'manifest.jsonl'), 'utf8')).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('keeps an scp-style remote (git@host:owner/repo.git) as written', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    git(repo, ['remote', 'set-url', 'origin', 'git@example.com:acme/app.git']);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toEqual({ remote: 'git@example.com:acme/app.git', commit: shas.onFeature });
  });

  // Claude Code records gitBranch "HEAD" for a detached checkout; HEAD is whatever is checked out now, so it is not the session's branch.
  it('does not read HEAD for a session that started detached (gitBranch HEAD): it goes through origin/HEAD', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    git(repo, ['checkout', '-q', 'feature']);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'HEAD'), assistant(S(1), 1, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toEqual({ remote: REMOTE, commit: shas.onMain });
  });

  it.each([
    ['ssh://git@example.com/home/alice/app.git'],
    ['git@example.com:/home/alice/app'],
    ['ssh://git@example.com/Users/alice/app.git'],
    ['https://example.com/C:/Users/alice/app.git'],
  ])('writes pointer: null for a remote whose path names an account on its host (%s)', async (remote) => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    makeRepo(repo);
    git(repo, ['remote', 'set-url', 'origin', remote]);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), assistant(S(1), 1, 'done')]);
    await stored(f);
    const counts = await buildPack(f.runtime, options(f));
    expect(pointerOf(manifest(f.out)[0])).toBeNull();
    expect(counts).toMatchObject({ emitted: 1, noPointer: 1 });
    expect(readFileSync(join(f.out, 'manifest.jsonl'), 'utf8')).not.toContain('alice');
  });

  // A commit the session made: the Bash call, and the result that names the sha the way `git commit` prints it.
  const committed = (session: string, n: number, branch: string, sha: string): string[] => [
    line({ type: 'assistant', uuid: uuidOf(session, 'a', n), parentUuid: null, isSidechain: false, timestamp: at(n), version: '2.1.300', sessionId: session, requestId: requestOf(session, n), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${String(n)}`, name: 'Bash', input: { command: 'git commit -m work' } }], usage: { input_tokens: 10, output_tokens: 20 } } }),
    line({ type: 'user', uuid: uuidOf(session, 'b', n), parentUuid: uuidOf(session, 'a', n), isSidechain: false, timestamp: at(n + 1), version: '2.1.300', sessionId: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${String(n)}`, content: `[${branch} ${sha.slice(0, 7)}] work\n 1 file changed, 1 insertion(+)` }] } }),
  ];

  const outcomeOf = (row: ManifestRow | undefined): unknown => (row === undefined ? undefined : Reflect.get(row, 'outcome'));

  it('says for each commit the session made whether the remote default branch holds it now: one landed, one not', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), ...committed(S(1), 3, 'main', shas.onMain), ...committed(S(1), 5, 'feature', shas.onFeature), assistant(S(1), 7, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    expect(outcomeOf(manifest(f.out)[0])).toEqual({ verify: 'na', commits: [{ sha: shas.onMain.slice(0, 7), landed: true }, { sha: shas.onFeature.slice(0, 7), landed: false }] });
  });

  it('reads landed: null for every commit when the remote default branch is not set (origin/HEAD unset)', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    const shas = makeRepo(repo);
    git(repo, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), ...committed(S(1), 3, 'main', shas.onMain), assistant(S(1), 5, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    expect(outcomeOf(manifest(f.out)[0])).toMatchObject({ commits: [{ sha: shas.onMain.slice(0, 7), landed: null }] });
  });

  it('reads landed: null for a sha the repository does not hold, and still lists it', async () => {
    const f = fixture();
    const repo = join(f.root, 'work', 'ptr');
    makeRepo(repo);
    writeFileSync(f.owners, JSON.stringify(OPTED_IN));
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test', repo, 'feature'), ...committed(S(1), 3, 'feature', 'abcdef1234567890abcdef1234567890abcdef12'), assistant(S(1), 5, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    expect(outcomeOf(manifest(f.out)[0])).toMatchObject({ commits: [{ sha: 'abcdef1', landed: null }] });
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

  it('reads the pointer opt-in, false unless an entry says true, and names the entry whose value is not a boolean', () => {
    const rules = parseOwners(JSON.stringify([{ folder: 'a', owner: 'A', license: null }, { folder: 'b', owner: 'B', license: null, pointer: true }, { folder: 'c', owner: 'C', license: null, pointer: false }]));
    expect(rules.map((rule) => rule.pointer)).toEqual([false, true, false]);
    for (const bad of ['true', 1, null]) expect(() => parseOwners(JSON.stringify([{ folder: 'a', owner: 'A', license: null }, { folder: 'b', owner: 'B', license: null, pointer: bad }]))).toThrow(/Owners entry 2.*pointer/);
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

  it('masks a session id or a line uuid written after a word and an underscore (session_<uuid>, x_<uuid>), whole', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, `see /tmp/session_${S(1)}.log and x_${uuidOf(S(1), 'b', 2)}`), assistant(S(1), 1, 'done'), user(S(1), 2, 'again')]);
    await stored(f);
    expect((await buildPack(f.runtime, options(f))).emitted).toBe(1);
    const text = packText(f.out);
    for (const id of [S(1), uuidOf(S(1), 'b', 2)]) expect(text).not.toContain(id);
    // Not even the first group of either: a prefix of the id is as good a join key.
    for (const id of [S(1), uuidOf(S(1), 'b', 2)]) expect(text).not.toContain(id.slice(0, 8));
  });
});

describe('the acceptance rule (plan S1)', () => {
  const turns = (session: string, count: number, label = 'ask'): string[] => Array.from({ length: count }, (_, n) => [user(session, 2 * n + 1, `${label} ${String(n)}`), assistant(session, 2 * n + 1, `answer ${String(n)}`)]).flat();

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

  const replayable = (text: string): object => {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : {};
  };

  it('drops a resumed session that replays an earlier one in favor of the longer, whichever is drawn first', async () => {
    const f = fixture();
    const earlier = turns(S(1), 2);
    // A resumed session starts with the earlier one's lines (same uuids, its own session id), then goes on.
    const replay = earlier.map((text) => line({ ...replayable(text), sessionId: S(2) }));
    f.write('-work-oars', S(1), earlier);
    f.write('-work-oars', S(2), [...replay, ...turns(S(2), 2)]);
    f.write('-work-oars', S(3), turns(S(3), 2, 'a different ask'));
    await stored(f);
    for (const seed of ['1', '2', '3', '4']) {
      const out = join(f.root, `pack-${seed}`);
      expect(await buildPack(f.runtime, options(f, { seed, out }))).toMatchObject({ duplicate: 1, emitted: 2 });
      expect(sessionsOf(f, out).sort()).toEqual([S(2), S(3)]);
    }
  });

  it('keys a duplicate on the text of the first prompt alone: a resumed copy that differs only in timestamp, uuid, parentUuid, and sessionId still loses to the longer session', async () => {
    const f = fixture();
    const earlier = turns(S(1), 2);
    const replay = earlier.map((text, n) => line({ ...replayable(text), sessionId: S(2), uuid: uuidOf(S(2), 'b', n), parentUuid: n === 0 ? null : uuidOf(S(2), 'a', n), timestamp: at(30 + n) }));
    f.write('-work-oars', S(1), earlier);
    f.write('-work-oars', S(2), [...replay, ...turns(S(2), 2)]);
    await stored(f);
    for (const seed of ['1', '2', '3', '4']) {
      const out = join(f.root, `pack-${seed}`);
      expect(await buildPack(f.runtime, options(f, { seed, out }))).toMatchObject({ duplicate: 1, emitted: 1 });
      expect(sessionsOf(f, out)).toEqual([S(2)]);
    }
  });

  it('does not key on what the harness wrote: two unrelated sessions that open with the same caveat, /clear, and tool-result lines are both emitted', async () => {
    const f = fixture();
    // A slash command's opener: an `isMeta` caveat, the command and its output, and a tool result. All of it is the same text in every session that starts this way.
    const opener = (session: string): string[] => [
      line({ ...replayable(user(session, 20, '<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>')), isMeta: true }),
      user(session, 21, '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
      user(session, 22, '<local-command-stdout></local-command-stdout>'),
      line({ ...replayable(user(session, 23, 'unused')), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'the same output' }] } }),
    ];
    f.write('-work-oars', S(1), [...opener(S(1)), ...turns(S(1), 2, 'fix the parser')]);
    f.write('-work-oars', S(2), [...opener(S(2)), ...turns(S(2), 2, 'write the docs')]);
    await stored(f);
    for (const seed of ['1', '2']) {
      const out = join(f.root, `pack-${seed}`);
      expect(await buildPack(f.runtime, options(f, { seed, out }))).toMatchObject({ duplicate: 0, emitted: 2 });
    }
  });

  it('keys on the text a person sends beside a tool result: two sessions that differ only there are both emitted', async () => {
    const f = fixture();
    const beside = (session: string, typed: string): string =>
      line({ ...replayable(user(session, 20, 'unused')), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'the same output' }, { type: 'text', text: typed }] } });
    f.write('-work-oars', S(1), [beside(S(1), 'use the first approach'), ...turns(S(1), 2, 'fix the parser')]);
    f.write('-work-oars', S(2), [beside(S(2), 'use the second approach'), ...turns(S(2), 2, 'fix the parser')]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f, { seed: '1', out: join(f.root, 'pack-beside') }))).toMatchObject({ duplicate: 0, emitted: 2 });
  });

  it('keeps two sessions that open with the same short text but go on differently, and two that open the same in different repositories', async () => {
    const f = fixture();
    const other = join(f.root, 'work', 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    writeFileSync(join(other, '.git', 'config'), `[remote "origin"]\n\turl = https://example.com/acme/other.git\n`);
    const opening = (session: string, second: string, cwd = repoCwd): string[] => [user(session, 1, 'continue', cwd), assistant(session, 1, 'ok'), user(session, 3, second, cwd), assistant(session, 3, 'ok')];
    f.write('-work-oars', S(1), opening(S(1), 'now the parser'));
    f.write('-work-oars', S(2), opening(S(2), 'now the docs'));
    f.write('-work-oars', S(3), [user(S(3), 1, 'go'), assistant(S(3), 1, 'ok')]);
    f.write('-work-oars', S(4), [user(S(4), 1, 'go', other), assistant(S(4), 1, 'ok')]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ duplicate: 0, emitted: 4 });
  });

  it('gates only the sessions the draw reaches and the members of a group that shares a first prompt: an undrawn singleton is never asked', async () => {
    const f = fixture();
    const earlier = turns(S(1), 2);
    f.write('-work-oars', S(1), earlier);
    f.write('-work-oars', S(2), [...earlier.map((text) => line({ ...replayable(text), sessionId: S(2) })), ...turns(S(2), 2)]);
    f.write('-work-oars', S(3), turns(S(3), 2, 'third'));
    f.write('-work-oars', S(4), turns(S(4), 2, 'fourth'));
    await stored(f);
    for (const seed of ['1', '2', '3', '4', '5', '6']) {
      gated.length = 0;
      const out = join(f.root, `pack-${seed}`);
      const counts = await buildPack(f.runtime, options(f, { seed, out, size: 1 }));
      const singles = new Set(gated.filter((session) => session === S(3) || session === S(4)));
      // The pair is always asked about (the loser is chosen among it); a single only when the draw reached it. With size 1 and no other rule firing, a singleton the draw reached is emitted, so the singletons gated are exactly the singletons emitted.
      expect(gated).toEqual(expect.arrayContaining([S(1), S(2)]));
      expect([...singles].sort()).toEqual(sessionsOf(f, out).filter((session) => session === S(3) || session === S(4)));
      expect(counts.emitted).toBe(1);
      expect(gated).toHaveLength(new Set(gated).size);
    }
  });

  it('chooses a duplicate loser only among sessions that pass every earlier rule: a longer twin another rule drops does not cost the shorter its place', async () => {
    const f = fixture();
    const earlier = turns(S(1), 2);
    const replay = earlier.map((text) => line({ ...replayable(text), sessionId: S(2) }));
    // The longer twin sits in a folder no owners entry names, so the shorter replay is the one to emit.
    f.write('-work-oars', S(1), earlier);
    f.write('-elsewhere-app', S(2), [...replay, ...turns(S(2), 2)]);
    await stored(f);
    for (const seed of ['1', '2', '3', '4']) {
      const out = join(f.root, `pack-${seed}`);
      expect(await buildPack(f.runtime, options(f, { seed, out }))).toMatchObject({ noOwner: 1, duplicate: 0, emitted: 1 });
      expect(sessionsOf(f, out)).toEqual([S(1)]);
    }
  });

  it('counts a duplicate that also holds a key as a duplicate: the cheaper check runs before the secret scan', async () => {
    const f = fixture();
    const earlier = turns(S(1), 2);
    const planted = 'my' + 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
    f.write('-work-oars', S(1), earlier);
    f.write('-work-oars', S(2), [...earlier.map((text) => line({ ...replayable(text), sessionId: S(2) })), ...turns(S(2), 2)]);
    f.write('-work-oars', S(3), [...earlier.map((text) => line({ ...replayable(text), sessionId: S(3) })), assistant(S(3), 9, `use ${planted}`)]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ duplicate: 2, secret: 0, emitted: 1 });
  });
});

describe('the run record', () => {
  it('writes how long the run took and how many bytes the pack holds (sessions, manifest, and census) into pack.json', async () => {
    const f = fixture();
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done')]);
    await stored(f);
    await buildPack(f.runtime, options(f));
    const pack: unknown = JSON.parse(readFileSync(join(f.out, 'pack.json'), 'utf8'));
    const field = (name: string): unknown => (typeof pack === 'object' && pack !== null ? Reflect.get(pack, name) : undefined);
    const held = [...packFiles(f.out), join(f.out, 'manifest.jsonl'), join(f.out, 'census.json')].reduce((sum, file) => sum + statSync(file).size, 0);
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

  it('finds a bare sk- key (OpenAI style) at a word edge, and does not find one stuck to a word', () => {
    const key = 'sk' + '-proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl';
    expect(secretIn(`key ${key}`)).toBe('API key');
    expect(secretIn(`key ${key} here`)).toBe('API key');
    // The guarded branch keeps its left guard: stuck to a word it is read as a hyphenated word, not a key.
    expect(secretIn(`task${key}`)).toBeUndefined();
  });

  it('passes ordinary text, a masked value, kebab-case words, and a masked URL', () => {
    for (const text of ['please rename the helper in parse.ts', 'token=<secret>', 'https://<secret>@example.com', 'the task-management-and-planning-notes and a disk-usage-report-for-the-quarter', 'Bearer <secret>']) expect(secretIn(text)).toBeUndefined();
  });

  it('leaves a base64 image out of the scan: a screenshot whose data holds a key shape is still emitted', async () => {
    const f = fixture();
    const shot = 'AI' + 'za' + 'A'.repeat(30);
    const image = line({ type: 'user', uuid: uuidOf(S(1), 'b', 5), parentUuid: null, isSidechain: false, timestamp: at(5), version: '2.1.300', sessionId: S(1), cwd: repoCwd, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `iVBORw0KGgo${shot}AAAA` } }, { type: 'text', text: 'what is on screen' }] } });
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done'), image]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ secret: 0, emitted: 1 });
    expect(packText(f.out)).toContain(shot);
  });

  it('leaves the image copy of a Read out of the scan too: toolUseResult.file.base64, whose object type is the media type', async () => {
    const f = fixture();
    const shot = 'AI' + 'za' + 'A'.repeat(30);
    const data = `iVBORw0KGgo${shot}AAAA`;
    // The harness records a Read of an image twice: in the tool_result block, and under `toolUseResult.file`, where the sibling `type` is the media type.
    const read = line({
      type: 'user',
      uuid: uuidOf(S(1), 'b', 5),
      parentUuid: null,
      isSidechain: false,
      timestamp: at(5),
      version: '2.1.300',
      sessionId: S(1),
      cwd: repoCwd,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01abc', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
      toolUseResult: { type: 'image', file: { base64: data, type: 'image/png', originalSize: 1024, dimensions: { originalWidth: 800, originalHeight: 600, displayWidth: 800, displayHeight: 600 } } },
    });
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done'), read]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ secret: 0, emitted: 1 });
  });

  it('blanks a base64 field only on an image: the same field on a non-image object is scanned as written', async () => {
    const f = fixture();
    const planted = 'my' + 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
    // A tool's own `base64` input (a bare field, then one beside a non-image media type) is text a person could have typed, so a key shape in it still drops the session.
    const encode = (session: string, n: number, extra: object): string => line({ type: 'user', uuid: uuidOf(session, 'b', n), parentUuid: null, isSidechain: false, timestamp: at(n), version: '2.1.300', sessionId: session, cwd: repoCwd, message: { role: 'user', content: 'encode this' }, ...extra });
    f.write('-work-oars', S(1), [user(S(1), 1, 'add a test'), assistant(S(1), 1, 'done'), encode(S(1), 5, { toolUseResult: { base64: planted } })]);
    f.write('-work-oars', S(2), [user(S(2), 1, 'add a spec'), assistant(S(2), 1, 'done'), encode(S(2), 5, { toolUseResult: { file: { base64: planted, type: 'text/plain' } } })]);
    f.write('-work-oars', S(3), [user(S(3), 1, 'add a doc'), assistant(S(3), 1, 'done'), encode(S(3), 5, { toolUseResult: { file: { base64: planted, type: 'image/png' } } })]);
    await stored(f);
    expect(await buildPack(f.runtime, options(f))).toMatchObject({ secret: 2, emitted: 1 });
    expect(sessionsOf(f)).toEqual([S(3)]);
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

// A Codex session as the harness writes it: the rollout is the only copy (oars archives nothing for a source), so it reaches the pack only through the store's own record of where it lives.
const CODEX_ID = 'cccc3333-3333-4333-8333-333333333333';
// Lowercase hex: a mixed-case call id is read as a secret and redacted before the masking sees it.
const CODEX_CALL = 'call_9f2e7a41c6b8d305e1a7f482';
const CODEX_AGENTS_LINE = 'Prefer the amber ledger for every receipt';
const codexTime = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;

const joined = (...rows: string[]): string => rows.join(String.fromCharCode(10));

const codexRollout = (call = CODEX_CALL): object[] => {
  const cwd = repoCwd;
  const message = (role: string, kind: string, text: string, second: number): object => rolloutLine(codexTime(second), 'response_item', { type: 'message', role, content: [{ type: kind, text }] });
  return [
    rolloutLine(codexTime(0), 'session_meta', { session_id: CODEX_ID, id: CODEX_ID, timestamp: codexTime(0), cwd, originator: 'codex_cli_rs', cli_version: '0.50.0', instructions: `${CODEX_AGENTS_LINE} (base)` }),
    rolloutLine(codexTime(1), 'turn_context', { model: 'gpt-5-codex', cwd }),
    message('user', 'input_text', joined('<user_instructions>', CODEX_AGENTS_LINE, '</user_instructions>'), 2),
    message('user', 'input_text', joined('<environment_context>', `  <cwd>${cwd}</cwd>`, '  <shell>bash</shell>', '</environment_context>'), 3),
    message('user', 'input_text', joined(`# AGENTS.md instructions for ${cwd}`, '', CODEX_AGENTS_LINE), 4),
    rolloutLine(codexTime(5), 'event_msg', { type: 'user_message', message: 'fix the build' }),
    rolloutLine(codexTime(6), 'response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: call }),
    rolloutLine(codexTime(7), 'response_item', { type: 'function_call_output', call_id: call, output: joined('Exit code: 0', 'Output:', 'README.md') }),
    rolloutLine(codexTime(8), 'event_msg', { type: 'agent_message', message: 'fixed' }),
  ];
};

/** Deposits the rollout into the fixture's store and returns the runtime that also reads Codex's store: the rollout stays where Codex wrote it. */
const withCodex = async (f: Fixture, rollout: readonly object[], more: readonly { id: string; lines: readonly object[] }[] = []): Promise<SessionsRuntime> => {
  const home = stageCodex(f.root, [{ id: CODEX_ID, lines: rollout }, ...more]);
  // The fixture runtime names no sources, which reads none; this one reads Codex's.
  const { storeDir, projectsRoot, stdin, stdout } = f.runtime;
  const runtime: SessionsRuntime = { storeDir, projectsRoot, stdin, stdout, sourceRoots: { codex: home } };
  await deposit(runtime, { allow: ['codex'], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  return runtime;
};

const ownersAll = (f: Fixture): string => {
  const owners = join(f.root, 'owners-all.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*', owner: 'Many Oars Co.', license: null }]));
  return owners;
};

describe('the harness terms gate', () => {
  it('leaves out a session from a harness with no terms row, after the exclusion gate has cleared its rollout', async () => {
    const f = fixture();
    const runtime = await withCodex(f, codexRollout());
    // Codex has a row now; the gate is proved by taking it away for the one run.
    const row = HARNESS_TERMS.codex;
    Reflect.deleteProperty(HARNESS_TERMS, 'codex');
    try {
      expect(await buildPack(runtime, options(f, { owners: ownersAll(f) }))).toMatchObject({ scanned: 1, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, noOwner: 0, noHarnessTerms: 1, emitted: 0 });
    } finally {
      Reflect.set(HARNESS_TERMS, 'codex', row);
    }
    expect(existsSync(join(f.out, 'sessions'))).toBe(false);
    expect(manifest(f.out)).toEqual([]);
  });
});

describe('a Codex session (plan S2)', () => {
  const packed = async (f: Fixture, rollout: readonly object[] = codexRollout()): Promise<PackCounts> => buildPack(await withCodex(f, rollout), options(f, { owners: ownersAll(f) }));

  it('clears the exclusion gate on the rollout alone and is packed', async () => {
    const f = fixture();
    expect(await packed(f)).toMatchObject({ scanned: 1, excluded: { term: 0, noRaw: 0 }, noHarnessTerms: 0, emitted: 1 });
    expect(manifest(f.out)).toMatchObject([
      {
        harness: 'codex',
        training: 'not-offered',
        harnessTerms: [
          { name: 'OpenAI Terms of Use', version: 'effective 2026-01-01' },
          { name: 'OpenAI Usage Policies', version: 'effective 2026-11-20' },
        ],
      },
    ]);
  });

  it('keeps no <user_instructions>, <environment_context>, or AGENTS.md text, only the keyed marker that stands for each', async () => {
    const f = fixture();
    expect(await packed(f)).toMatchObject({ emitted: 1 });
    const text = packText(f.out);
    for (const gone of [CODEX_AGENTS_LINE, '<shell>bash</shell>', '# AGENTS.md instructions']) expect(text).not.toContain(gone);
    expect(text).toMatch(/\[injected user-instructions [0-9a-f]+\]/);
    expect(text).toMatch(/\[injected environment-context [0-9a-f]+\]/);
    expect(text).toMatch(/\[injected agents-md [0-9a-f]+\]/);
    // What the person typed and what the model answered stay.
    expect(text).toContain('fix the build');
    expect(text).toContain('fixed');
  });

  it('masks the session id and every call id, the same way wherever each occurs, and writes neither raw', async () => {
    const f = fixture();
    expect(await packed(f)).toMatchObject({ emitted: 1 });
    const [row] = manifest(f.out);
    // The whole pack, skeleton.json included, holds none of the raw ids; only the transcript lines are parsed.
    const everything = packText(f.out);
    expect(everything).not.toContain(CODEX_ID);
    expect(everything).not.toContain(CODEX_CALL);
    expect(everything).not.toContain(CODEX_CALL.slice(5));
    const text = transcriptText(f.out);
    const records = text.split(String.fromCharCode(10)).filter((entry) => entry !== '').map((entry): unknown => JSON.parse(entry));
    const callIds = records.flatMap((record) => {
      const payload: unknown = typeof record === 'object' && record !== null ? Reflect.get(record, 'payload') : undefined;
      const id: unknown = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'call_id') : undefined;
      return typeof id === 'string' ? [id] : [];
    });
    // The call and its output still name one call, and the call id keeps the shape of the id it stands for.
    expect(callIds).toHaveLength(2);
    expect(callIds[0]).toBe(callIds[1]);
    expect(callIds[0]).toMatch(/^call_[0-9a-f]{24}$/);
    // The rollout's own id is the session's match id, as a Claude Code line's sessionId is.
    expect(text).toContain(row?.matchId);
  });

  it('deduplicates a resumed Codex rollout (same first message, its own id and timestamps) in favor of the longer', async () => {
    const f = fixture();
    const other = 'dddd4444-4444-4444-8444-444444444444';
    const later = (text: string): string => text.replace(/2026-06-01T10:00:(\d\d)/g, '2026-06-02T11:30:$1');
    const resumed: object[] = [
      ...codexRollout().map((entry): object => {
        const copy: unknown = JSON.parse(later(JSON.stringify(entry)).split(CODEX_ID).join(other));
        return typeof copy === 'object' && copy !== null ? copy : {};
      }),
      rolloutLine(codexTime(20), 'event_msg', { type: 'user_message', message: 'and the lint' }),
      rolloutLine(codexTime(21), 'event_msg', { type: 'agent_message', message: 'linted' }),
    ];
    const runtime = await withCodex(f, codexRollout(), [{ id: other, lines: resumed }]);
    expect(await buildPack(runtime, options(f, { owners: ownersAll(f) }))).toMatchObject({ duplicate: 1, emitted: 1 });
    expect(packText(f.out)).toContain('and the lint');
  });

  it('writes no raw call id when the redactor took it first as a secret', async () => {
    const f = fixture();
    const random = 'call_Qx7LmN2vTz9RkPb4WcYd8HsJ';
    expect(await packed(f, codexRollout(random))).toMatchObject({ emitted: 1 });
    expect(packText(f.out)).not.toContain(random);
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
