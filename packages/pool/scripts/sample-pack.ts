// The first sale's sample pack (P98 (10) to (12)): a local folder of an operator's own sessions, for the operator to read before any buyer sees one.
// Nothing here sends anything: it reads a sessions store and the harness's transcripts, and writes one folder that must sit outside every repository.
// Order, per session: the exclusion gate (A38) first, then a known owner and known harness terms, the turn floor, a repository, and no duplicate, then redaction, masking, and the secret scan, then the copy, with every injected block stripped.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { defaultConfigDir } from '../../cli/src/credentials.js';
import { checkSession, transcriptFilesOf, type Reason } from '../../cli/src/sessions/exclusion.js';
import { LEADING_TAG, LOCAL_COMMAND_TAGS } from '../../cli/src/sessions/extract.js';
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
 * The terms each harness puts on its user, with each page's version as the page itself prints it, read on 2026-11-10 (t1103): Anthropic's Consumer Terms (effective 2025-10-08) and
 * Usage Policy (effective 2026-11-12), OpenAI's Terms of Use (effective 2026-01-01) and Usage Policies (effective 2026-11-20). A lot sold before an effective date rests on the version before it.
 * `training` is `priced-add-on` only where the terms allow training on outputs; Anthropic's Usage Policy forbids it "without prior authorization from Anthropic", and OpenAI's bars
 * supplying training material for a model that substitutes for OpenAI's.
 * A harness with no row here is left out of a pack: a session whose terms are not known carries no rights to state.
 */
export const HARNESS_TERMS: { readonly [harness in Harness]?: { terms: readonly HarnessTerms[]; training: 'priced-add-on' | 'not-offered' } } = {
  'claude-code': {
    terms: [
      { name: 'Anthropic Consumer Terms', version: 'effective 2025-10-08' },
      { name: 'Anthropic Usage Policy', version: 'effective 2026-11-12' },
    ],
    training: 'not-offered',
  },
  codex: {
    terms: [
      { name: 'OpenAI Terms of Use', version: 'effective 2026-01-01' },
      { name: 'OpenAI Usage Policies', version: 'effective 2026-11-20' },
    ],
    training: 'not-offered',
  },
};

export interface OwnerRule {
  folder: string;
  owner: string;
  license: string | null;
  /** Accounts (GitHub users or organizations) this entry's repositories live under, masked as `<owner>` besides the one each session's own remote names. */
  handles?: readonly string[];
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
  /** User plus assistant turns a session needs to be taken; plan S1 sets 20. */
  minTurns: number;
}

export interface PackCounts {
  /** Main sessions with a user turn in the store: what the draw runs over. */
  frame: number;
  /** Sessions the draw reached, in draw order, until `size` were emitted or the frame ran out. */
  scanned: number;
  excluded: { term: number; noRaw: number; noTerms: number; unreadable: number };
  noOwner: number;
  noHarnessTerms: number;
  /** Under `minTurns` user plus assistant turns. */
  tooShort: number;
  /** No repository recorded for the session. */
  noRepo: number;
  /** A resumed session that replays another's first prompt and is the shorter of the two. */
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
    const handles = field('handles');
    if (handles === undefined) return { folder, owner, license };
    if (!Array.isArray(handles) || handles.some((handle: unknown) => !isText(handle) || handle.trim() === '')) throw new PackError(`Owners entry ${String(at + 1)} needs handles as a list of account names.`);
    return { folder, owner, license, handles: handles.map(String) };
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

// A candidate id: a uuid, or a `req_`/`call_` id. Any other `word_` prefix is not one, or it would eat the first group of a uuid that follows it (`session_<uuid>`). A candidate is
// rewritten only when it is a known id, so other words that match are left alone.
const UUID_OR_PREFIXED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:req|call)_[0-9A-Za-z]+/gi;

// `accountUuid": "<uuid>` as it reads inside a JSON string, the quotes plain or escaped.
const QUOTED_UUID = /uuid\\*"\s*:\s*\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** The working folders a raw transcript names (the `cwd` of a line), read before redaction. */
const cwdsOf = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const row of text.split('\n')) {
    if (!row.includes('"cwd"')) continue;
    const entry = parsed(row);
    const cwd: unknown = isRecord(entry) ? Reflect.get(entry, 'cwd') : undefined;
    if (typeof cwd === 'string' && cwd !== '') found.add(cwd);
  }
  return found;
};

/** The keys whose value is an id: Claude Code's `uuid`, `parentUuid`, `leafUuid`, ... and `requestId`, and Codex's `call_id`, `session_id`, and `forked_from_id`. */
const isIdKey = (key: string): boolean => /uuid$/i.test(key) || ['requestId', 'call_id', 'session_id', 'forked_from_id'].includes(key);

/** The line ids a transcript carries: the value of every id key at any depth, and a Codex `session_meta` line's own `id` (a bare `id` is no id key elsewhere). */
const lineIdsOf = (value: unknown, found: Set<string>): void => {
  if (Array.isArray(value)) for (const item of value) lineIdsOf(item, found);
  else if (isRecord(value)) {
    const payload: unknown = Reflect.get(value, 'payload');
    const own: unknown = Reflect.get(value, 'type') === 'session_meta' && isRecord(payload) ? Reflect.get(payload, 'id') : undefined;
    if (typeof own === 'string') found.add(own);
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && isIdKey(key)) found.add(item);
      else lineIdsOf(item, found);
    }
  }
};

// `url = <remote>` lines of a git config, and the account in one: `https://host/acme/app.git`, `git@host:acme/app.git`, `ssh://git@host/acme/app`.
const CONFIG_URL = /^[ \t]*url[ \t]*=[ \t]*(\S+)[ \t]*$/gm;
const REMOTE_ACCOUNT = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?[^/:\s]+[:/]([^/\s]+)\/[^/\s]+$/i;

/** The git config a working folder belongs to: its own `.git/config`, or a linked worktree's common one (`.git` is then a file naming `<repo>/.git/worktrees/<name>`). */
const configOf = async (cwd: string): Promise<string | undefined> => {
  for (let folder = cwd; ; folder = dirname(folder)) {
    const dot = join(folder, '.git');
    try {
      if ((await stat(dot)).isDirectory()) return join(dot, 'config');
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dot, 'utf8'))?.[1];
      return pointer === undefined ? undefined : join(resolve(folder, pointer.trim()), '..', '..', 'config');
    } catch {
      if (dirname(folder) === folder) return undefined;
    }
  }
};

/** The accounts the remotes of the repositories a session ran in name; a folder that is gone, or has no remote, adds none. */
const accountsOf = async (cwds: Iterable<string>): Promise<string[]> => {
  const found = new Set<string>();
  for (const cwd of cwds) {
    const config = await configOf(cwd);
    const text = config === undefined ? '' : await readFile(config, 'utf8').catch(() => '');
    for (const [, url] of text.matchAll(CONFIG_URL)) {
      const account = REMOTE_ACCOUNT.exec(url ?? '')?.[1];
      if (account !== undefined && !/^\d+$/.test(account)) found.add(account);
    }
  }
  return [...found];
};

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/**
 * One id under the keyed index, shaped as the id it stands for: a line uuid stays a uuid and a prefixed id (`req_`, `call_`) keeps its prefix.
 * The same function as the match id, so a buyer's masks are stable across packs and no one without the index key can test an id against them.
 */
const maskOf = (indexKey: string, buyerKey: string, id: string): string => {
  const hex = matchIdOf(buyerKey, serverKeyOf(indexKey, id));
  const prefix = /^([A-Za-z]+)_/.exec(id)?.[1];
  return prefix !== undefined ? `${prefix}_${hex.slice(0, 24)}` : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Every store session id (to its match id) and every line id the texts carry, rewritten wherever it occurs: the `sessionId` field, a path, a typed mention. Other text is left alone. */
const maskIds = (texts: readonly string[], sessions: ReadonlyMap<string, string>, indexKey: string, buyerKey: string): string[] => {
  const lineIds = new Set<string>();
  for (const text of texts) {
    for (const line of text.split('\n')) lineIdsOf(parsed(line), lineIds);
    // A key ending in `uuid` inside a quoted settings file or tool output: no line carries it as a key, but its value is the same kind of id.
    for (const [, id] of text.matchAll(QUOTED_UUID)) if (id !== undefined) lineIds.add(id);
  }
  return texts.map((text) => text.replace(UUID_OR_PREFIXED, (id) => sessions.get(id) ?? (lineIds.has(id) ? maskOf(indexKey, buyerKey, id) : id)));
};

/** The text of a user message's content, or undefined when it has none to type: a message of only tool results (the harness answering the model) and an image with no words carry nothing the person wrote. Text sent beside a tool result is the person's, so it counts. */
const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const blocks: unknown[] = content;
  const texts = blocks.flatMap((block): string[] => {
    const text: unknown = isRecord(block) && Reflect.get(block, 'type') === 'text' ? Reflect.get(block, 'text') : undefined;
    return typeof text === 'string' ? [text] : [];
  });
  return texts.length === 0 ? undefined : texts.join('\n');
};

/**
 * The text a line carries as something the person typed: a Claude Code `user` line's `message.content`, or a Codex rollout's `user_message` event. Undefined for every other line, and for
 * the harness's own user lines: an `isMeta` line, one that opens with a local command's tag (`<local-command-caveat>`, `<command-name>`, ...), and a tool result. The same text opens
 * unrelated sessions, so none of it can say that one session resumes another.
 */
const typedOf = (entry: unknown): string | undefined => {
  if (!isRecord(entry)) return undefined;
  const type: unknown = Reflect.get(entry, 'type');
  if (type === 'user') {
    const message: unknown = Reflect.get(entry, 'message');
    const text = Reflect.get(entry, 'isMeta') === true || !isRecord(message) ? undefined : textOf(Reflect.get(message, 'content'));
    const leading = text === undefined ? undefined : LEADING_TAG.exec(text.trimStart())?.[1];
    return text === undefined || text.trim() === '' || (leading !== undefined && LOCAL_COMMAND_TAGS.has(leading)) ? undefined : text;
  }
  const payload: unknown = Reflect.get(entry, 'payload');
  const message: unknown = type === 'event_msg' && isRecord(payload) && Reflect.get(payload, 'type') === 'user_message' ? Reflect.get(payload, 'message') : undefined;
  return typeof message === 'string' ? message : undefined;
};

/** The first `limit` things the person typed in a transcript, in order, as the harness wrote them (fewer when the session holds fewer). Nothing else of a line is read: a resume rewrites `sessionId`, `uuid`, `parentUuid`, and `timestamp`. */
const typedPromptsOf = async (path: string, limit: number): Promise<string[]> => {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const found: string[] = [];
  try {
    for await (const text of lines) {
      const typed = typedOf(parsed(text));
      if (typed !== undefined) found.push(typed);
      if (found.length >= limit) break;
    }
    return found;
  } finally {
    lines.close();
    stream.destroy();
  }
};

/** How many typed turns say that two sessions are one conversation: a resume replays the start of the one it continues, so the first few turns agree. */
const PROMPTS_COMPARED = 3;

interface TurnCount {
  session: string;
  project: string;
  turns: number;
  repo: string | null;
}

/** One list is the start of the other: a resumed copy replays the earlier session's turns (all of them, or the first few) and goes on. */
const startsTheOther = (a: readonly string[], b: readonly string[]): boolean => a.every((text, n) => text === b[n]) || b.every((text, n) => text === a[n]);

/**
 * The sessions that lose to a longer one replaying their first prompts (a tie goes to the lower session id), so the rule gives the same lot whichever of the two the draw reaches first.
 * Every session of the frame is keyed first on its first typed turn and its repository (one cheap line read each, no gate). Only a group of two or more is asked `accepted` and read for its
 * first three typed turns: the loser is chosen among the members that pass every earlier rule, and a member loses only to one whose turns it starts or that starts its turns. Two sessions that
 * open with the same word and go on differently are both kept.
 */
const duplicatesOf = async <T extends TurnCount>(runtime: SessionsRuntime, frame: readonly T[], accepted: (member: T) => Promise<boolean>): Promise<Set<string>> => {
  const groups = new Map<string, { member: T; path: string }[]>();
  for (const candidate of frame) {
    const main = (await transcriptFilesOf(runtime, candidate.project, candidate.session)).find((file) => file.main);
    const [first] = main === undefined ? [] : await typedPromptsOf(main.path, 1);
    if (main !== undefined && first !== undefined) {
      const key = JSON.stringify([candidate.repo, first]);
      groups.set(key, [...(groups.get(key) ?? []), { member: candidate, path: main.path }]);
    }
  }
  const losers = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const live: { member: T; prompts: string[] }[] = [];
    for (const { member, path } of group) if (await accepted(member)) live.push({ member, prompts: await typedPromptsOf(path, PROMPTS_COMPARED) });
    live.sort((a, b) => b.member.turns - a.member.turns || (a.member.session < b.member.session ? -1 : 1));
    const kept: { member: T; prompts: string[] }[] = [];
    for (const candidate of live) {
      if (kept.some((winner) => startsTheOther(winner.prompts, candidate.prompts))) losers.add(candidate.member.session);
      else kept.push(candidate);
    }
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

/**
 * An image's base64 can hold any shape by chance (the redactor keeps it), so the scan reads the line without it: the `data` of a `type: 'base64'` source, and the `base64` of a Read's
 * `toolUseResult.file`, whose object `type` is the media type (`image/...`). A `base64` field on any other object, and a line with neither, is scanned as written.
 */
const withoutImageData = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutImageData);
  if (!isRecord(value)) return value;
  const type: unknown = Reflect.get(value, 'type');
  const source = type === 'base64';
  const media = typeof type === 'string' && type.startsWith('image/');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' && ((source && key === 'data') || (media && key === 'base64')) ? '' : withoutImageData(item)]));
};

/** The text the secret scan reads: the transcript with every base64 image's data left out. */
const scannable = (text: string): string =>
  text
    .split('\n')
    .map((row) => {
      const entry = row.includes('"base64"') ? parsed(row) : undefined;
      return entry === undefined ? row : JSON.stringify(withoutImageData(entry));
    })
    .join('\n');

type StoredSession = Awaited<ReturnType<typeof loadStore>>['sessions'][number];
type HarnessRow = NonNullable<(typeof HARNESS_TERMS)[Harness]>;

/** What the rules before the duplicate check decide: the count a session adds to, or what it carries on. */
type Early = { left: (counts: PackCounts) => void } | { accepted: { owner: OwnerRule; harness: Harness; terms: HarnessRow } };

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
  // A source's store id is `<harness>-<id>` while its file names the bare id (a Codex rollout's `session_meta.id`): both are the session.
  for (const session of store.sessions) {
    const prefix = `${harnessOf(session)}-`;
    const match = sessionIds.get(session.session);
    if (harnessOf(session) !== 'claude-code' && session.session.startsWith(prefix) && match !== undefined) sessionIds.set(session.session.slice(prefix.length), match);
  }
  const order = (session: string): string => createHash('sha256').update(`${options.seed}\n${session}`).digest('hex');
  const drawn = frame.map((session) => ({ session, rank: order(session.session) })).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const counts: PackCounts = { frame: frame.length, scanned: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, noOwner: 0, noHarnessTerms: 0, tooShort: 0, noRepo: 0, duplicate: 0, secret: 0, emitted: 0 };
  const turnsOf = (session: { userTurns: number; assistantTurns: number }): number => session.userTurns + session.assistantTurns;
  // The rules up to the repository one, once per session: the duplicate rule asks them only of the members of a group that shares a first prompt, the draw of the sessions it reaches; a singleton the draw never reaches is never gated.
  const earlyBy = new Map<string, Promise<Early>>();
  const early = async (record: StoredSession): Promise<Early> => {
    const verdict = await checkSession(runtime, options.terms, record.project, record.session);
    if (verdict.reason !== 'clean') {
      const reason = EXCLUDED[verdict.reason];
      return { left: (c) => { c.excluded[reason] += 1; } };
    }
    const owner = ownerOf(owners, record.project);
    if (owner === undefined) return { left: (c) => { c.noOwner += 1; } };
    const harness = harnessOf(record);
    const terms = HARNESS_TERMS[harness];
    if (terms === undefined) return { left: (c) => { c.noHarnessTerms += 1; } };
    if (turnsOf(record) < options.minTurns) return { left: (c) => { c.tooShort += 1; } };
    if (record.repo === null) return { left: (c) => { c.noRepo += 1; } };
    return { accepted: { owner, harness, terms } };
  };
  const earlyOf = (record: StoredSession): Promise<Early> => {
    const known = earlyBy.get(record.session) ?? early(record);
    earlyBy.set(record.session, known);
    return known;
  };
  let losers: Set<string> | undefined;
  const rows: ManifestRow[] = [];
  const index: IndexRow[] = [];
  await mkdir(partial, { recursive: true });
  for (const { session: record } of drawn) {
    if (counts.emitted >= options.size) break;
    counts.scanned += 1;
    const decided = await earlyOf(record);
    if ('left' in decided) {
      decided.left(counts);
      continue;
    }
    const { owner, harness, terms } = decided.accepted;
    // Read once, on the first session that gets this far. A loser is chosen only among sessions that pass every rule above, so a longer twin that one of them drops never costs the shorter its place; a duplicate's other half may not be drawn at all.
    if (losers === undefined) {
      const everyone = frame.map((record) => ({ session: record.session, project: record.project, turns: turnsOf(record), repo: record.repo, record }));
      losers = await duplicatesOf(runtime, everyone, async (member) => 'accepted' in (await earlyOf(member.record)));
    }
    if (losers.has(record.session)) {
      counts.duplicate += 1;
      continue;
    }
    const matchId = matchIdOf(options.buyerKey, serverKeyOf(indexKey, record.session));
    const files = await transcriptFilesOf(runtime, record.project, record.session);
    const raws = await Promise.all(files.map((file) => readFile(file.path, 'utf8')));
    // The accounts this session's repositories live under: the owners entry's, and what the remote of each working folder names.
    const handles = [...(owner.handles ?? []), ...(await accountsOf(new Set(raws.flatMap((raw) => [...cwdsOf(raw)]))))];
    const texts = raws.map((raw) => redactTranscript(raw, domains, names, injectedKey, { handles, toolId: (id) => maskOf(indexKey, options.buyerKey, id), fetchedHosts: true }).text);
    const masked = maskIds(texts, sessionIds, indexKey, options.buyerKey);
    // After redaction and masking, before the first byte is written: a session with a hit leaves no file, manifest row, or index row.
    if (masked.some((text) => secretIn(scannable(text)) !== undefined)) {
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
