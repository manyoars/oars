// The first sale's sample pack (P98 (10) to (12)): a local folder of an operator's own sessions, for the operator to read before any buyer sees one.
// Nothing here sends anything: it reads a sessions store and the harness's transcripts, and writes one folder that must sit outside every repository.
// Order, per session: the exclusion gate (A38) first, then a known owner and known harness terms, the turn floor, a repository, and no duplicate, then the copy, with every injected block stripped.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { defaultConfigDir } from '../../cli/src/credentials.js';
import { checkSession, transcriptFilesOf, type Reason } from '../../cli/src/sessions/exclusion.js';
import { localNames, redactTranscript, REDACTION_VERSION } from '../../cli/src/sessions/redact.js';
import { harnessOf, type Harness } from '../../cli/src/sessions/schema.js';
import { loadStore, readRedactDomains, type SessionsRuntime } from '../../cli/src/sessions/store.js';

export const USAGE = [
  'Usage: sample-pack --terms <file> --owners <file> --index-key <file> --buyer-key <key> --out <dir> [--size <n>] [--seed <text>] [--min-turns <n>]',
  '  --terms <file>       the exclusion term list (one term per line; a local file, never in a repository)',
  '  --owners <file>      JSON list of {"folder": "<glob over the project folder name>", "owner": "<company>", "license": "<SPDX id>" | null}; first match wins, and a session in a folder no entry names is left out',
  '  --index-key <file>   the matching-index key (64 hex characters or more): a session\'s server key is HMAC-SHA-256 of its id under it. Keep it; a new key gives every session new ids',
  '  --buyer-key <key>    the buyer\'s key: a match id is HMAC-SHA-256 of the server key under it',
  '  --out <dir>          an empty or new folder outside every git repository',
  '  --size <n>           sessions to emit (default 25); --seed <text> orders the draw (default 1)',
  '  --min-turns <n>      a session needs at least this many turns, user plus assistant (default 20); a shorter one is left out and counted',
  'Reads the store under APPDATA (or XDG_CONFIG_HOME) and the transcripts under CLAUDE_CONFIG_DIR or ~/.claude. Builds in <out>.partial and renames it to --out when done,',
  'and appends each session id and its match id to index.jsonl beside the owners file: the operator\'s only map from one to the other.',
].join('\n');

/** What a buyer may do with a session; training is never in this list (it is the `training` field). P98 (11). */
export const PERMITTED_USES = ['evaluation', 'benchmarking', 'task-design'] as const;

export interface HarnessTerms {
  name: string;
  version: string;
}

/**
 * The terms each harness puts on its user, as read on 2026-11-09 (umbrella `docs/business/2026-11-09-first-sale-buyers-pricing.md`, "Terms that bind a sale").
 * `training` is `priced-add-on` only where the terms allow training on outputs; the Usage Policy forbids it "without prior authorization from Anthropic".
 * A harness with no row here is left out of a pack: a session whose terms are not known carries no rights to state.
 */
export const HARNESS_TERMS: { readonly [harness in Harness]?: { terms: readonly HarnessTerms[]; training: 'priced-add-on' | 'not-offered' } } = {
  'claude-code': {
    terms: [
      { name: 'Anthropic Consumer Terms', version: 'effective 2025-10-08' },
      { name: 'Anthropic Usage Policy', version: 'page version 2026-11-12' },
    ],
    training: 'not-offered',
  },
};

export interface OwnerRule {
  folder: string;
  owner: string;
  license: string | null;
}

/** No session id: a buyer holds only the match id, and the operator's `index.jsonl` maps one to the other. */
export interface ManifestRow {
  matchId: string;
  harness: Harness;
  harnessVersions: string[];
  repoOwner: string;
  sourceLicense: string | null;
  harnessTerms: HarnessTerms[];
  permittedUses: string[];
  training: 'priced-add-on' | 'not-offered';
  transcripts: number;
  redactionVersion: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface PackOptions {
  terms: string;
  owners: string;
  indexKey: string;
  buyerKey: string;
  out: string;
  size: number;
  seed: string;
  /** User plus assistant turns a session needs to be taken; plan S1 sets 20, and Matt confirms the count. */
  minTurns: number;
}

export interface PackCounts {
  /** Main sessions with a user turn in the store: what the draw runs over. */
  frame: number;
  /** Sessions the exclusion gate read, in draw order, until `size` were emitted or the frame ran out. */
  scanned: number;
  excluded: { term: number; noRaw: number; noTerms: number; unreadable: number };
  noOwner: number;
  noHarnessTerms: number;
  /** Under `minTurns` user plus assistant turns. */
  tooShort: number;
  /** No repository recorded for the session. */
  noRepo: number;
  /** A resumed session that replays another's first prompt line and is the shorter of the two. */
  duplicate: number;
  /** Dropped because the redacted, masked text still held something shaped like a key (`secretIn`); nothing of the session was written. */
  secret: number;
  emitted: number;
}

/** A line of the operator's `index.jsonl`: which pack a session went to, and under which match id. It never goes into a pack. */
export interface IndexRow {
  pack: string;
  session: string;
  project: string;
  matchId: string;
}

export class PackError extends Error {}

const isText = (value: unknown): value is string => typeof value === 'string';

/** The owners file: a JSON list, each entry a folder glob, an owner, and a license or null. A malformed entry stops the run rather than leaving a session unowned or owned by the wrong entry. */
export const parseOwners = (text: string): OwnerRule[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new PackError('The owners file must be a JSON list.');
  return parsed.map((entry: unknown, at): OwnerRule => {
    const fields: object = typeof entry === 'object' && entry !== null ? entry : {};
    const field = (name: string): unknown => {
      const value: unknown = Reflect.get(fields, name);
      return value;
    };
    const [folder, owner, license] = [field('folder'), field('owner'), field('license')];
    if (!isText(folder) || folder === '') throw new PackError(`Owners entry ${String(at + 1)} has no folder.`);
    if (!isText(owner) || owner.trim() === '') throw new PackError(`Owners entry ${String(at + 1)} has no owner.`);
    if (license !== null && !isText(license)) throw new PackError(`Owners entry ${String(at + 1)} needs a license string or null.`);
    return { folder, owner, license };
  });
};

const globOf = (folder: string): RegExp => new RegExp(`^${folder.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/** The first entry whose glob matches the whole project folder name. */
export const ownerOf = (rules: readonly OwnerRule[], project: string): OwnerRule | undefined => rules.find((rule) => globOf(rule.folder).test(project));

/** The session's key in the matching index: one per session, held by whoever holds the index key, so nobody without it can test a session id against a match id. */
export const serverKeyOf = (indexKey: string, session: string): string => createHmac('sha256', indexKey).update(session).digest('hex');

/** A buyer's opaque id for a session: two buyers' ids for one session cannot be joined without the buyer keys, and one buyer's id is the same in every pack. */
export const matchIdOf = (buyerKey: string, serverKey: string): string => createHmac('sha256', buyerKey).update(serverKey).digest('hex');

const readIndexKey = async (file: string): Promise<string> => {
  const key = (await readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{64,}$/i.test(key)) throw new PackError('The index key must be 64 or more hex characters.');
  return key;
};

const insideRepository = (folder: string): boolean => {
  for (let at = resolve(folder); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return true;
    if (dirname(at) === at) return false;
  }
};

const isEmptyOrAbsent = async (folder: string): Promise<boolean> => {
  try {
    return (await readdir(folder)).length === 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
};

const UUID_OR_REQUEST = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|req_[0-9A-Za-z]+/gi;

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** The line ids a transcript carries: the value of every key ending in `uuid` (`uuid`, `parentUuid`, `leafUuid`, ...) and every `requestId`, at any depth. */
const lineIdsOf = (value: unknown, found: Set<string>): void => {
  if (Array.isArray(value)) for (const item of value) lineIdsOf(item, found);
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (/uuid$/i.test(key) || key === 'requestId')) found.add(item);
      else lineIdsOf(item, found);
    }
};

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/**
 * One id under the keyed index, shaped as the id it stands for: a line uuid stays a uuid and a request id a `req_` id.
 * The same function as the match id, so a buyer's masks are stable across packs and no one without the index key can test an id against them.
 */
const maskOf = (indexKey: string, buyerKey: string, id: string): string => {
  const hex = matchIdOf(buyerKey, serverKeyOf(indexKey, id));
  return id.startsWith('req_') ? `req_${hex.slice(0, 24)}` : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Every store session id (to its match id) and every line id the texts carry, rewritten wherever it occurs: the `sessionId` field, a path, a typed mention. Other text is left alone. */
const maskIds = (texts: readonly string[], sessions: ReadonlyMap<string, string>, indexKey: string, buyerKey: string): string[] => {
  const lineIds = new Set<string>();
  for (const text of texts) for (const line of text.split('\n')) lineIdsOf(parsed(line), lineIds);
  return texts.map((text) => text.replace(UUID_OR_REQUEST, (id) => sessions.get(id) ?? (lineIds.has(id) ? maskOf(indexKey, buyerKey, id) : id)));
};

/** What a resumed session shares with the one it continues: its first user line, as the harness replays it, without the session id it rewrites. Undefined when the transcript has no user line. */
const firstPromptKey = async (path: string): Promise<string | undefined> => {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      const entry = parsed(text);
      if (isRecord(entry) && Reflect.get(entry, 'type') === 'user') return JSON.stringify(Object.entries(entry).filter(([key]) => key !== 'sessionId'));
    }
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
};

interface TurnCount {
  session: string;
  project: string;
  turns: number;
}

/** The sessions that lose to a longer one replaying their first prompt line (a tie goes to the lower session id), so the rule gives the same lot whichever of the two the draw reaches first. */
const duplicatesOf = async (runtime: SessionsRuntime, candidates: readonly TurnCount[]): Promise<Set<string>> => {
  const groups = new Map<string, TurnCount[]>();
  for (const candidate of candidates) {
    const main = (await transcriptFilesOf(runtime, candidate.project, candidate.session)).find((file) => file.main);
    const key = main === undefined ? undefined : await firstPromptKey(main.path);
    if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const losers = new Set<string>();
  for (const group of groups.values()) {
    const [winner] = [...group].sort((a, b) => b.turns - a.turns || (a.session < b.session ? -1 : 1));
    for (const member of group) if (member !== winner) losers.add(member.session);
  }
  return losers;
};

/**
 * The key shapes `redact.ts` masks (its `PATTERNS`), read again over the redacted output, and unanchored: the redactor's rules start at a word boundary, so a key stuck to the
 * word before it (`myAKIA...`) is one it can miss, and a pack that goes to a buyer is held to the stricter test. A hit drops the whole session; nothing is repaired here.
 * A placeholder (`token=<secret>`, `https://<secret>@host`) is not a hit. `sk-` outside `sk-ant-` keeps a left guard and a digit, so `task-management-notes` is not read as a key.
 */
const SECRET_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key id', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['API key', /sk-ant-[A-Za-z0-9_-]{16,}|(?<![A-Za-z0-9])sk-(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}/],
  ['Stripe key', /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/],
  ['Stripe webhook secret', /whsec_[A-Za-z0-9]{10,}/],
  ['Slack token', /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['JSON web token', /eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}/],
  ['password in a URL', /[a-z][a-z0-9+.-]*:[/][/][^\s/:@<]+:[^\s/@<]+@/i],
];

/** The name of the first secret shape the text holds, or undefined when it holds none. */
export const secretIn = (text: string): string | undefined => SECRET_SHAPES.find(([, shape]) => shape.test(text))?.[0];

const EXCLUDED: { readonly [reason in Exclude<Reason, 'clean'>]: keyof PackCounts['excluded'] } = { term: 'term', 'no-raw': 'noRaw', 'no-terms': 'noTerms', unreadable: 'unreadable' };

/** Where a transcript goes under the session's folder: `main.jsonl`, or its path under the session (`subagents/agent-x.jsonl`). */
const placeOf = (key: string, session: string, main: boolean): string => (main ? 'main.jsonl' : key.slice(session.length + 1));

export const buildPack = async (runtime: SessionsRuntime, options: PackOptions): Promise<PackCounts> => {
  const started = Date.now();
  // Bytes of the pack's `sessions/` files and `manifest.jsonl`; `pack.json` holds the number, so it is not in it.
  let bytes = 0;
  const out = resolve(options.out);
  // Built here and renamed to `out` at the end, so a run that stops partway leaves no half pack where a finished one belongs.
  const partial = `${out}.partial`;
  if (insideRepository(out)) throw new PackError('The output folder is inside a git repository. Choose one outside every repository: a pack is never committed.');
  // `index.jsonl` (session id to match id) is appended beside the owners file, so that folder is held to the same rule as the pack: the map must never be committed.
  if (insideRepository(dirname(resolve(options.owners)))) throw new PackError('The owners file is inside a git repository, and the operator index is written beside it. Move the owners file outside every repository.');
  if (!(await isEmptyOrAbsent(out))) throw new PackError('The output folder is not empty. Choose a new folder, so one pack never mixes with another.');
  if (!(await isEmptyOrAbsent(partial))) throw new PackError(`An unfinished pack from an earlier run is at ${partial}. Delete it, then run again.`);
  const owners = parseOwners(await readFile(options.owners, 'utf8'));
  const indexKey = await readIndexKey(options.indexKey);
  const domains = await readRedactDomains(runtime.storeDir);
  const names = localNames();
  // One injected-block key per buyer: within a pack the same CLAUDE.md gives the same marker, and two buyers' markers cannot be compared.
  const injectedKey = `injected-block:${createHmac('sha256', options.buyerKey).update('injected-block').digest('hex')}`;
  const store = await loadStore(runtime.storeDir);
  const frame = store.sessions.filter((session) => session.userTurns > 0);
  // Every session the store knows, so a transcript that names another session names it by that session's match id.
  const sessionIds = new Map(store.sessions.map((session) => [session.session, matchIdOf(options.buyerKey, serverKeyOf(indexKey, session.session))]));
  const order = (session: string): string => createHash('sha256').update(`${options.seed}\n${session}`).digest('hex');
  const drawn = frame.map((session) => ({ session, rank: order(session.session) })).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const counts: PackCounts = { frame: frame.length, scanned: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, noOwner: 0, noHarnessTerms: 0, tooShort: 0, noRepo: 0, duplicate: 0, secret: 0, emitted: 0 };
  const turnsOf = (session: { userTurns: number; assistantTurns: number }): number => session.userTurns + session.assistantTurns;
  let losers: Set<string> | undefined;
  const rows: ManifestRow[] = [];
  const index: IndexRow[] = [];
  await mkdir(partial, { recursive: true });
  for (const { session: record } of drawn) {
    if (counts.emitted >= options.size) break;
    counts.scanned += 1;
    const verdict = await checkSession(runtime, options.terms, record.project, record.session);
    if (verdict.reason !== 'clean') {
      counts.excluded[EXCLUDED[verdict.reason]] += 1;
      continue;
    }
    const owner = ownerOf(owners, record.project);
    if (owner === undefined) {
      counts.noOwner += 1;
      continue;
    }
    const harness = harnessOf(record);
    const terms = HARNESS_TERMS[harness];
    if (terms === undefined) {
      counts.noHarnessTerms += 1;
      continue;
    }
    if (turnsOf(record) < options.minTurns) {
      counts.tooShort += 1;
      continue;
    }
    if (record.repo === null) {
      counts.noRepo += 1;
      continue;
    }
    // Read once, on the first session that gets this far, over every session the earlier cheap rules leave: a duplicate's other half may not be drawn at all.
    losers ??= await duplicatesOf(
      runtime,
      frame.filter((session) => turnsOf(session) >= options.minTurns && session.repo !== null).map((session) => ({ session: session.session, project: session.project, turns: turnsOf(session) })),
    );
    if (losers.has(record.session)) {
      counts.duplicate += 1;
      continue;
    }
    const matchId = matchIdOf(options.buyerKey, serverKeyOf(indexKey, record.session));
    const files = await transcriptFilesOf(runtime, record.project, record.session);
    const texts: string[] = [];
    for (const file of files) texts.push(redactTranscript(await readFile(file.path, 'utf8'), domains, names, injectedKey).text);
    const masked = maskIds(texts, sessionIds, indexKey, options.buyerKey);
    // After redaction and masking, before the first byte is written: a session with a hit leaves no file, manifest row, or index row.
    if (masked.some((text) => secretIn(text) !== undefined)) {
      counts.secret += 1;
      continue;
    }
    for (const [at, file] of files.entries()) {
      const target = join(partial, 'sessions', matchId, placeOf(file.key, record.session, file.main));
      await mkdir(dirname(target), { recursive: true });
      const body = masked[at] ?? '';
      bytes += Buffer.byteLength(body);
      await writeFile(target, body);
    }
    index.push({ pack: out, session: record.session, project: record.project, matchId });
    rows.push({
      matchId,
      harness,
      harnessVersions: [...record.versions],
      repoOwner: owner.owner,
      sourceLicense: owner.license,
      harnessTerms: [...terms.terms],
      permittedUses: [...PERMITTED_USES],
      training: terms.training,
      transcripts: files.length,
      redactionVersion: REDACTION_VERSION,
      startedAt: record.tsFirst,
      endedAt: record.tsLast,
    });
    counts.emitted += 1;
  }
  const manifest = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  bytes += Buffer.byteLength(manifest);
  await writeFile(join(partial, 'manifest.jsonl'), manifest);
  await writeFile(join(partial, 'pack.json'), `${JSON.stringify({ built: new Date().toISOString(), size: options.size, seed: options.seed, minTurns: options.minTurns, redactionVersion: REDACTION_VERSION, counts, bytes, elapsedMs: Date.now() - started }, null, 2)}\n`);
  // Outside the pack, beside the owners file, and appended, so it maps every pack built from that folder. Written before the rename, so a pack under `out` always has its rows.
  await appendFile(join(dirname(resolve(options.owners)), 'index.jsonl'), index.map((row) => `${JSON.stringify(row)}\n`).join(''));
  // An empty `out` was allowed above, and a folder is renamed only onto a free name.
  if (existsSync(out)) await rmdir(out);
  await rename(partial, out);
  return counts;
};

export interface Io {
  runtime: SessionsRuntime;
  print: (text: string) => void;
}

const VALUED = new Set(['--terms', '--owners', '--index-key', '--buyer-key', '--out', '--size', '--seed', '--min-turns']);

const parseArgs = (argv: readonly string[]): PackOptions | string => {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const [flag, value] = [argv[at] ?? '', argv[at + 1]];
    if (!VALUED.has(flag) || value === undefined) return `Unknown or incomplete option: ${flag}`;
    values.set(flag, value);
  }
  const [terms, owners, indexKey, buyerKey, out] = ['--terms', '--owners', '--index-key', '--buyer-key', '--out'].map((flag) => values.get(flag));
  if (terms === undefined || owners === undefined || indexKey === undefined || buyerKey === undefined || out === undefined) return 'Missing a required option.';
  const size = Number(values.get('--size') ?? '25');
  if (!Number.isInteger(size) || size < 1) return '--size takes a whole number of 1 or more.';
  const minTurns = Number(values.get('--min-turns') ?? '20');
  if (!Number.isInteger(minTurns) || minTurns < 1) return '--min-turns takes a whole number of 1 or more.';
  return { terms, owners, indexKey, buyerKey, out, size, seed: values.get('--seed') ?? '1', minTurns };
};

/** The command: 0 when the pack was written, 2 on a usage or input error (nothing written), with counts only on success: no term, path, or transcript text. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    io.print(`${options}\n${USAGE}`);
    return 2;
  }
  try {
    const counts = await buildPack(io.runtime, options);
    const { term, noRaw, noTerms, unreadable } = counts.excluded;
    io.print(
      [
        `Wrote ${String(counts.emitted)} sessions to ${options.out} (manifest.jsonl, sessions/<match id>/).`,
        `Scanned ${String(counts.scanned)} of ${String(counts.frame)} in draw order. Excluded: ${String(term)} for a term, ${String(noRaw)} with no raw, ${String(noTerms)} with no term file, ${String(unreadable)} unreadable.`,
        `Left out after the gate: ${String(counts.noOwner)} in a folder no owner entry names, ${String(counts.noHarnessTerms)} from a harness with no terms row, ${String(counts.tooShort)} under ${String(options.minTurns)} turns, ${String(counts.noRepo)} with no repository, ${String(counts.duplicate)} replaying a longer session, ${String(counts.secret)} holding a secret after redaction.`,
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof PackError) && !(error instanceof SyntaxError)) throw error;
    io.print(error.message);
    return 2;
  }
};

/** The runtime the CLI itself would use, from the environment: a test or a copied store points APPDATA (or XDG_CONFIG_HOME) and CLAUDE_CONFIG_DIR elsewhere. */
export const runtimeOf = (env: NodeJS.ProcessEnv): SessionsRuntime => ({
  storeDir: join(defaultConfigDir(env, process.platform, homedir()), 'oars', 'sessions'),
  projectsRoot: join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
  sources: [],
  stdin: process.stdin,
  stdout: { write: () => true },
});
