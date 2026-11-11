// The first sale's sample pack (P98 (10) to (12)): a local folder of an operator's own sessions, for the operator to read before any buyer sees one.
// Nothing here sends anything: it reads a sessions store and the harness's transcripts, and writes one folder that must sit outside every repository.
// Order, per session: the exclusion gate (A38) first, then a known owner and known harness terms, the turn floor, a repository, and no duplicate, then redaction, masking, and the secret scan, then the copy, with every injected block stripped.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { defaultConfigDir } from '../../cli/src/credentials.js';
import { checkSession, loadTerms, transcriptFilesOf, type Reason } from '../../cli/src/sessions/exclusion.js';
import { configOf, makeRepoRoot, originUrl } from '../../cli/src/sessions/repo-root.js';
import { LEADING_TAG, LOCAL_COMMAND_TAGS } from '../../cli/src/sessions/extract.js';
import { bucketOf, floorOf, sessionsOf, skeletonOf, type SessionSkeleton, type SkeletonTool, type TranscriptRoot, type WireGate } from '../../cli/src/sessions/pool-wire.js';
import { shellReader } from '../../cli/src/sessions/projection.js';
import { contentHash } from '../../cli/src/sessions/read.js';
import { localNames, makeRedactor, redactTranscript, REDACTION_VERSION } from '../../cli/src/sessions/redact.js';
import { harnessOf, type Harness, type PromptVerify } from '../../cli/src/sessions/schema.js';
import { loadStore, readRedactDomains, readSkeletons, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { runGit, type Git } from '../../cli/src/sessions/survival.js';
import { vocabulary } from '../../cli/src/sessions/vocab-load.js';

export const USAGE = [
  'Usage: sample-pack --terms <file> --owners <file> --index-key <file> --buyer-key <key> --out <dir> [--size <n>] [--seed <text>] [--min-turns <n>] [--sessions <file>]',
  '  --terms <file>       the exclusion term list (one term per line; a local file, never in a repository)',
  '  --owners <file>      JSON list of {"folder": "<glob over the project folder name>", "owner": "<company>", "license": "<SPDX id>" | null}; first match wins, and a session in a folder no entry names is left out',
  '  --index-key <file>   the matching-index key (64 hex characters or more): a session\'s server key is HMAC-SHA-256 of its id under it. Keep it; a new key gives every session new ids',
  '  --buyer-key <key>    the buyer\'s key: a match id is HMAC-SHA-256 of the server key under it',
  '  --out <dir>          an empty or new folder outside every git repository',
  '  --size <n>           sessions to emit (default 25); --seed <text> orders the draw (default 1)',
  '  objections.jsonl     beside the owners file, optional: a line per objection, naming a session id or a person; each session it names, or whose text names the person, is left out and counted (docs/pool.md)',
  '  --sessions <file>    build the pack from exactly the store session ids in this file (one per line) in place of the seeded draw; every rule still applies, and each listed session left out is printed with the reason (term, noOwner, lead, tooShort, duplicate, secret, notFound, ...). Not with --size or --seed',
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

const IN_FORCE = 'the version in force when the session was made';

/**
 * The terms each harness puts on its user, with each page's version as the page itself prints it, read on 2026-11-10 (t1103, M2): Anthropic's Consumer Terms (effective 2025-10-08) and
 * Usage Policy (the page read is effective 2026-11-12), OpenAI's Terms of Use (effective 2026-01-01) and Usage Policies (the page read is effective 2026-11-20). A session made before a page's
 * effective date rests on the version before it, which was not read, so a policy row says "the version in force when the session was made" and the page read follows as its own row named by its effective date
 * with what it adds (t1135 item 7). `training` is `priced-add-on` only where the terms allow training on outputs; the Anthropic Usage Policy from 2026-11-12 forbids it "without prior authorization from Anthropic", and OpenAI's
 * bars supplying training material for a model that substitutes for OpenAI's.
 * A harness with no row here is left out of a pack: a session whose terms are not known carries no rights to state.
 */
export const HARNESS_TERMS: { readonly [harness in Harness]?: { terms: readonly HarnessTerms[]; training: 'priced-add-on' | 'not-offered' } } = {
  'claude-code': {
    terms: [
      { name: 'Anthropic Consumer Terms', version: 'effective 2025-10-08' },
      { name: 'Anthropic Usage Policy', version: IN_FORCE },
      { name: 'Anthropic Usage Policy, from 2026-11-12', version: 'effective 2026-11-12; bars using outputs to train an AI model without prior authorization from Anthropic' },
    ],
    training: 'not-offered',
  },
  codex: {
    terms: [
      { name: 'OpenAI Terms of Use', version: 'effective 2026-01-01' },
      { name: 'OpenAI Usage Policies', version: IN_FORCE },
      { name: 'OpenAI Usage Policies, from 2026-11-20', version: 'effective 2026-11-20; bars supplying training material or signals for a model meant to substitute for an OpenAI model' },
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
  /** First prompts (`/handoff resume`) that mark a session of this entry's repositories as an orchestration lead session, beside `LEAD_PROMPTS`: ordinary work in one repository, a lead's resume in another, so the operator says which. */
  leadPrompts?: readonly string[];
  /** The owner opts in to the repository pointer and the outcome block (plan S4): a private remote names the repository and a sha names private work, so nothing is read or shipped without it. */
  pointer: boolean;
}

/** Where a session started, read at pack time because the store holds only a salted hash. `commit` is null when no branch of the session and no default branch holds a commit from before it began. */
export interface RepositoryPointer {
  remote: string;
  commit: string | null;
}

/** One commit the session made (the sha as the shell printed it) and whether the remote's default branch holds it now; null when that cannot be told (the sha is not in the repository, or the remote has no default branch ref). */
export interface OutcomeCommit {
  sha: string;
  landed: boolean | null;
}

/** A block, not a score: the last prompt's verify, and where each commit went. */
export interface Outcome {
  verify: PromptVerify | null;
  commits: OutcomeCommit[];
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
  /** The session's model names with the count of prompts run under each: the skeleton's prompt frames, so a name has passed the wire's gate. The store's own `models` counts a line that names a requested model, which most sessions never carry. */
  models: Tally;
  /** User plus assistant turns, the count the turn floor reads. */
  turns: number;
  /** The file beside the transcripts that holds the session's skeleton. */
  skeleton: string;
  /** Only for an owner who opted in: null when the repository cannot be found, has no `origin`, or whose remote is not kept (counted in `noPointer`). */
  pointer?: RepositoryPointer | null;
  /** Only for an owner who opted in. */
  outcome?: Outcome;
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
  /** Extra first-prompt patterns of an orchestration lead session, beside `LEAD_PROMPTS`. */
  leadPrompts?: readonly RegExp[];
  /** Runs one read-only git command, as `oars pool deposit` takes `options.git ?? runGit`; a test injects its own. */
  git?: Git | undefined;
  /** The vocabulary folder, for a caller bundled into a `data:` URL (sample-pack.mjs), where the CLI cannot find its own shipped copy. */
  vocabDir?: URL | undefined;
  /** Store session ids to build the pack from, in place of the seeded draw (`--sessions`): every other rule still applies, and `size` and `seed` are not used. */
  sessions?: readonly string[] | undefined;
  /** Told of each listed session that does not make the pack, with the count that kept it out (`term`, `noOwner`, `lead`, `tooShort`, `duplicate`, `secret`, ..., or `notFound`). */
  onDrop?: ((session: string, reason: string) => void) | undefined;
}

export interface PackCounts {
  /** Main sessions with a user turn in the store: what the draw runs over. */
  frame: number;
  /** Sessions the draw reached, in draw order, until `size` were emitted or the frame ran out. */
  scanned: number;
  excluded: { term: number; noRaw: number; noTerms: number; unreadable: number };
  noOwner: number;
  noHarnessTerms: number;
  /** An orchestration lead session (its first prompt matches `LEAD_PROMPTS`): private company business, never drawn. */
  lead: number;
  /** Under `minTurns` user plus assistant turns. */
  tooShort: number;
  /** No repository recorded for the session. */
  noRepo: number;
  /** A resumed session that replays another's first prompt and is the shorter of the two. */
  duplicate: number;
  /** The store holds no skeleton for the session (captured before steps and frames, or with no root), so it has none to pack. */
  noSkeleton: number;
  /** An emitted session of an owner who opted in whose repository could not be found, has no `origin`, or whose remote is not kept, so its `pointer` is null. */
  noPointer: number;
  /** Dropped because `objections.jsonl` names the session or its text holds a named person (Art. 21(1)); nothing of it was written. */
  objected: number;
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

/** What an objection covers. A pack is a sale, so `sale` and `all` keep a session out; `training` does too, because lot 1 cannot hand a session over for evaluation and withhold it from training. */
export const OBJECTION_SCOPES = ['sale', 'training', 'all'] as const;

/** A line of the operator's `objections.jsonl`, beside the owners file: a session id or a person's name, when the objection arrived (a full ISO time, kept for the Art. 21 register), and the scope. */
export interface Objection {
  session?: string;
  name?: string;
  received: string;
  scope: (typeof OBJECTION_SCOPES)[number];
}

export const OBJECTIONS_FILE = 'objections.jsonl';

export const isText = (value: unknown): value is string => typeof value === 'string';

/** A read that found no file. */
export const isAbsent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The owners file: a JSON list, each entry a folder glob, an owner, a license or null, and optionally `"pointer": true`. A malformed entry stops the run rather than leaving a session unowned or owned by the wrong entry. */
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
    const names = (name: string, label: string): string[] | undefined => {
      const value = field(name);
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((item: unknown) => !isText(item) || item.trim() === '')) throw new PackError(`Owners entry ${String(at + 1)} needs ${name} as a list of ${label}.`);
      return value.map(String);
    };
    const [handles, leadPrompts] = [names('handles', 'account names'), names('leadPrompts', 'first prompts')];
    const raw = field('pointer');
    const pointer = raw === undefined ? false : raw;
    if (typeof pointer !== 'boolean') throw new PackError(`Owners entry ${String(at + 1)} needs pointer to be true or false.`);
    return { folder, owner, license, pointer, ...(handles === undefined ? {} : { handles }), ...(leadPrompts === undefined ? {} : { leadPrompts }) };
  });
};

const isScope = (value: unknown): value is Objection['scope'] => OBJECTION_SCOPES.some((scope) => scope === value);

/** The SHA-256 of `objections.jsonl` as read, or this when the file is absent: pack.json records it, and `deliver` refuses a pack whose recorded value is not the file's now. */
export const NO_OBJECTIONS = 'none';

/** The objections beside the owners file (`dir`) with the hash of the bytes they were read from; none when the file is absent. A line that cannot be read stops the run, so no session leaves on a guess about whose objection it was. */
export const readObjections = async (dir: string): Promise<{ objections: Objection[]; hash: string }> => {
  let text: string;
  try {
    text = await readFile(join(dir, OBJECTIONS_FILE), 'utf8');
  } catch (error) {
    if (isAbsent(error)) return { objections: [], hash: NO_OBJECTIONS };
    throw error;
  }
  const objections = text.split(String.fromCharCode(10)).filter((row) => row.trim() !== '').map((row, at): Objection => {
    const where = `${OBJECTIONS_FILE} line ${String(at + 1)}`;
    const fields: object = (() => {
      try {
        const parsed: unknown = JSON.parse(row);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch {
        throw new PackError(`${where} is not JSON.`);
      }
    })();
    const field = (name: string): unknown => {
      const value: unknown = Reflect.get(fields, name);
      return value;
    };
    const [session, name, received, scope] = [field('session'), field('name'), field('received'), field('scope')];
    if (session !== undefined && (!isText(session) || session === '')) throw new PackError(`${where} needs session to be a session id.`);
    if (name !== undefined && (!isText(name) || name.trim() === '')) throw new PackError(`${where} needs name to be a person's name.`);
    if (session === undefined && name === undefined) throw new PackError(`${where} names no session and no person.`);
    if (!isText(received) || !received.includes('T') || Number.isNaN(Date.parse(received))) throw new PackError(`${where} needs received to be an ISO date and time, such as 2026-06-05T09:30:00Z.`);
    if (!isScope(scope)) throw new PackError(`${where} needs scope to be one of ${OBJECTION_SCOPES.join(', ')}.`);
    return { ...(session === undefined ? {} : { session }), ...(name === undefined ? {} : { name }), received, scope };
  });
  return { objections, hash: createHash('sha256').update(text).digest('hex') };
};

/** Every string a transcript holds once its JSON is decoded, keys and values, including JSON carried inside a string: a name a `\u` escape hides from the raw bytes is found here whether or not redaction rewrote the line. */
export const decodedStrings = (body: string): string[] => {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value);
      const inner = value.trimStart();
      if (inner.startsWith('{') || inner.startsWith('[')) {
        try {
          walk(JSON.parse(value));
        } catch {
          // Prose that opens with a brace: the string itself is already collected.
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        out.push(key);
        walk(item);
      }
    }
  };
  for (const row of body.split(String.fromCharCode(10))) {
    try {
      walk(JSON.parse(row));
    } catch {
      // Not a JSON line: the raw text is searched as it stands.
    }
  }
  return out;
};

/** Lower case with runs of white space made one, so a name matches across a line break or a doubled space. */
export const squashed = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

const globOf = (folder: string): RegExp => new RegExp(`^${folder.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/** The first entry whose glob matches the whole project folder name. */
export const ownerOf = (rules: readonly OwnerRule[], project: string): OwnerRule | undefined => rules.find((rule) => globOf(rule.folder).test(project));

/** The session's key in the matching index: one per session, held by whoever holds the index key, so nobody without it can test a session id against a match id. */
export const serverKeyOf = (indexKey: string, session: string): string => createHmac('sha256', indexKey).update(session).digest('hex');

/** Which buyer key a recipient's match ids belong to: the first 16 hex of the key's SHA-256, never the key (plan 2.2). */
export const keyIdOf = (buyerKey: string): string => createHash('sha256').update(buyerKey).digest('hex').slice(0, 16);

/** A buyer's opaque id for a session: two buyers' ids for one session cannot be joined without the buyer keys, and one buyer's id is the same in every pack. */
export const matchIdOf = (buyerKey: string, serverKey: string): string => createHmac('sha256', buyerKey).update(serverKey).digest('hex');

const readIndexKey = async (file: string): Promise<string> => {
  const key = (await readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{64,}$/i.test(key)) throw new PackError('The index key must be 64 or more hex characters.');
  return key;
};

export const insideRepository = (folder: string): boolean => {
  for (let at = resolve(folder); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return true;
    if (dirname(at) === at) return false;
  }
};

const isEmptyOrAbsent = async (folder: string): Promise<boolean> => {
  try {
    return (await readdir(folder)).length === 0;
  } catch (error) {
    if (isAbsent(error)) return true;
    throw error;
  }
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// The harness's own prefixed ids, masked wherever they stand (tool output, a pasted log): `toolu_01...`, `msg_01...`, `req_011C...`. A word like `msg_handler_func` is no id, so the tail must run 16 or more
// characters and hold a digit, as every id the vendor issues does.
const ID_TAIL = '_(?=[A-Za-z_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{14,}[A-Za-z0-9]';
const HARNESS_PREFIXED = `(?:srvtoolu|toolu|msg|req)${ID_TAIL}`;

// A candidate id: a uuid, a harness-prefixed id, or any `req_`/`call_` token. Any other `word_` prefix is not one, or it would eat the first group of a uuid that follows it (`session_<uuid>`). A uuid or
// a `call_` token is rewritten only when it is a known id, so other words that match are left alone.
const UUID_OR_PREFIXED = new RegExp(`${UUID}|(?<![A-Za-z0-9])${HARNESS_PREFIXED}|(?:req|call)_[0-9A-Za-z]+`, 'gi');
const HARNESS_ID = new RegExp(`^${HARNESS_PREFIXED}$`, 'i');
const WHOLE_UUID = new RegExp(`^${UUID}$`, 'i');

/** An id this module already masked with `maskOf` (`toolu_`, `msg_`, or `req_` and 24 hex): masking it again would only give the one id a second value. Other prefixes are not skipped: a Codex `call_` id is hex of its own. */
const MASKED_PREFIXED = /^(?:(?:srv)?toolu|msg|req)_[0-9a-f]{24}$/;

/** A `msg_` or `req_` id as the vendor issues it (mixed case, high entropy), found anywhere in raw transcript text. */
const VENDOR_ID = new RegExp(`(?<![A-Za-z0-9])(?:msg|req)${ID_TAIL}`, 'g');

/** The keys whose value is an id besides those ending in `uuid`: Claude Code's `requestId`, Codex's `call_id`, `session_id`, and `forked_from_id`, and the line, request, prompt, delivery, and message ids of the store's own records (t1135). */
const ID_KEYS: readonly string[] = ['requestId', 'call_id', 'session_id', 'forked_from_id', 'requestRef', 'serverClassifierRequest', 'promptId', 'toolUseID', 'tool_use_id', 'deliveryId', 'delivery_id', 'messageId', 'msg_id'];

// `accountUuid": "<uuid>`, `leafUuid: <id>`, `promptId=<id>` as it reads inside a JSON string or pasted output, the quotes plain, escaped, or absent.
const QUOTED_ID = new RegExp(`(uuid|${ID_KEYS.join('|')})\\\\*["']?\\s*[:=]\\s*\\\\*["']?([0-9A-Za-z][0-9A-Za-z_-]{7,})`, 'gi');

/**
 * A uuid under a key inside JSON that was written into a string (a transcript pasted or read into a tool result), so its quotes are backslash-escaped, once or more: `\"id\":\"<uuid>\"`,
 * `\"serverClassifierContext\":{\"request\":\"<uuid>\"`, `\"base\":\"<uuid>\"`. No line of the pack need carry the id as a key for these to be ids (t1138). An unescaped key is a real line field, read by `lineIdsOf`.
 * A prefixed id (`toolu_`, `msg_`, `req_`) under these keys is masked wherever it stands, so only the uuid shape needs the key.
 */
const ESCAPED_KEYED: readonly { key: string; pattern: RegExp }[] = [
  { key: 'id', pattern: new RegExp(`(?<![A-Za-z0-9_])id\\\\+"\\s*:\\s*\\\\+"(${UUID})`, 'gi') },
  { key: 'request', pattern: new RegExp(`serverClassifierContext\\\\+"\\s*:\\s*\\{\\s*\\\\+"request\\\\+"\\s*:\\s*\\\\+"(${UUID})`, 'gi') },
  { key: 'base', pattern: new RegExp(`(?<![A-Za-z0-9_])base\\\\+"\\s*:\\s*\\\\+"(${UUID})`, 'gi') },
];

/** The nil uuid is a code literal, never an id. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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

/** The keys whose value is an id: Claude Code's `uuid`, `parentUuid`, `leafUuid`, ... and the keys in `ID_KEYS`. */
const isIdKey = (key: string): boolean => /uuid$/i.test(key) || ID_KEYS.includes(key);

/** Whether the uuid and prefixed-token patterns reach `id` whole; any other id (an opaque `ref-7f3a...`) needs a pattern of its own. */
const reachedWhole = (id: string): boolean => WHOLE_UUID.test(id) || HARNESS_ID.test(id) || /^(?:req|call)_[0-9A-Za-z]+$/i.test(id);

/** The characters an id the opaque pattern can match is made of. */
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** A value found under a named id key is an id whatever its length: a uuid, a prefixed token, or any token of id characters. */
const keyedId = (value: string): boolean => reachedWhole(value) || TOKEN.test(value);

/** An id worth masking by its value when text only hints at it (`QUOTED_ID`): a uuid or prefixed token, or an opaque token of 8 or more characters with a digit in it (a word like `undefined` is no id). */
const looksLikeId = (value: string): boolean => reachedWhole(value) || (value.length >= 8 && /[0-9]/.test(value) && TOKEN.test(value));

/**
 * The line ids a transcript carries, each with the key it stood under: the value of every id key at any depth, a Codex `session_meta` line's own `id`, and the `id` of an `api-request` line (a bare `id` is
 * no id key elsewhere: a tool call's `id` is a `toolu_` id the redactor already masks).
 */
const lineIdsOf = (value: unknown, found: Map<string, string>): void => {
  if (Array.isArray(value)) for (const item of value) lineIdsOf(item, found);
  else if (isRecord(value)) {
    const payload: unknown = Reflect.get(value, 'payload');
    const type: unknown = Reflect.get(value, 'type');
    const own: unknown = type === 'session_meta' && isRecord(payload) ? Reflect.get(payload, 'id') : undefined;
    if (typeof own === 'string') found.set(own, 'session_meta.id');
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && (isIdKey(key) || (key === 'id' && type === 'api-request'))) found.set(item, key);
      else lineIdsOf(item, found);
    }
  }
};

// The account in a remote URL: `https://host/acme/app.git`, `git@host:acme/app.git`, `ssh://git@host/acme/app`.
const REMOTE_ACCOUNT = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?[^/:\s]+(?::\d+(?=\/))?[:/]([^/\s]+)\/[^\s]+$/i;

/** The accounts the `origin` remotes of the repositories a session ran in name (an upstream or submodule url is someone else's account); a folder that is gone, or has no origin, adds none. */
const accountsOf = (cwds: Iterable<string>): string[] => {
  const repoRoot = makeRepoRoot();
  const found = new Set<string>();
  for (const cwd of cwds) {
    const root = repoRoot(cwd);
    const url = root === null ? null : originUrl(configOf(root) ?? '');
    const account = url === null ? undefined : REMOTE_ACCOUNT.exec(url)?.[1];
    if (account !== undefined && !/^\d+$/.test(account)) found.add(account);
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
 * One id under the keyed index, shaped as the id it stands for: a line uuid stays a uuid, a prefixed id (`req_`, `call_`) keeps its prefix, and any other id becomes hex of its own length (8 to 64).
 * The same function as the match id, so a buyer's masks are stable across packs and no one without the index key can test an id against them. One raw id has one mask, whatever key it stood under.
 */
const maskOf = (indexKey: string, buyerKey: string, id: string): string => {
  const hex = matchIdOf(buyerKey, serverKeyOf(indexKey, id));
  const prefix = /^([A-Za-z]+)_/.exec(id)?.[1];
  if (prefix !== undefined) return `${prefix}_${hex.slice(0, 24)}`;
  if (WHOLE_UUID.test(id)) return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return hex.slice(0, Math.min(Math.max(id.length, 8), 64));
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One pattern matching each of `ids` wherever it stands as a whole token, longest first; null when there are none. */
const wholeTokens = (ids: readonly string[]): RegExp | null => {
  const longestFirst = [...ids].sort((a, b) => b.length - a.length);
  return longestFirst.length === 0 ? null : new RegExp(`(?<![A-Za-z0-9])(?:${longestFirst.map(escapeRegExp).join('|')})(?![A-Za-z0-9])`, 'g');
};

interface IdMasker {
  /** The ids it masks by value, each with the key it stood under. */
  ids: ReadonlyMap<string, string>;
  /** The text with every known id rewritten. */
  mask: (text: string) => string;
  /** The raw ids left in a text, counted by the key each stood under (`session` for a store session id, `prefixed id` for a `toolu_`, `msg_`, or `req_` shape): what the post-build scan looks for. */
  scan: (text: string) => ReadonlyMap<string, number>;
}

/**
 * A pattern for each key naming the values `entries` hold under it: the key, its quote and separator (plain, escaped, or absent), then the value as a whole token. Used for a keyed value that is no id shape (`"1"`, `"main"`):
 * it is masked only where it stands under its key, never wherever the same word or number appears.
 */
const underKeys = (entries: ReadonlyMap<string, string>): { key: string; pattern: RegExp }[] => {
  const byKey = new Map<string, string[]>();
  for (const [value, key] of entries) byKey.set(key, [...(byKey.get(key) ?? []), value]);
  return [...byKey].map(([key, values]) => ({
    key,
    pattern: new RegExp(`((?<![A-Za-z0-9_])${escapeRegExp(key)}\\\\*["']?\\s*[:=]\\s*\\\\*["']?)(${[...values].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![A-Za-z0-9._-])`, 'g'),
  }));
};

/** The ids a pack masks before redaction: the raw value of every named id key and of an api-request `id` that is no uuid or harness-prefixed id (those have their own routes). */
const keyedOpaque = (texts: readonly string[], sessions: ReadonlyMap<string, string>): Map<string, string> => {
  const found = new Map<string, string>();
  for (const text of texts) for (const row of text.split('\n')) lineIdsOf(parsed(row), found);
  return new Map([...found].filter(([id, key]) => (key === 'id' || ID_KEYS.includes(key)) && looksLikeId(id) && !WHOLE_UUID.test(id) && !HARNESS_ID.test(id) && !MASKED_PREFIXED.test(id) && !sessions.has(id)));
};

/**
 * The raw transcripts with every keyed opaque id already masked, and those masks: redaction's entropy rule would turn a mixed-case, high-entropy `deliveryId` into `<secret>` and cut its link, so the keyed mask comes
 * first, as it does for a `msg_` or `req_` id. The masks are handed on so the later pass does not mask them a second time.
 */
const premasked = (raws: readonly string[], sessions: ReadonlyMap<string, string>, indexKey: string, buyerKey: string): { texts: string[]; masks: Set<string>; ids: ReadonlyMap<string, string> } => {
  const ids = keyedOpaque(raws, sessions);
  const pattern = wholeTokens([...ids.keys()]);
  const masks = new Set<string>();
  const texts = raws.map((raw) => (pattern === null ? raw : raw.replace(pattern, (id) => {
    const mask = maskOf(indexKey, buyerKey, id);
    masks.add(mask);
    return mask;
  })));
  return { texts, masks, ids };
};

/**
 * Every store session id (to its match id) and every line id the texts carry, rewritten wherever it occurs: the `sessionId` field, a path, a typed mention. A harness-prefixed id (`toolu_`, `msg_`, `req_`) is
 * masked wherever it stands, known or not. A uuid that no line carries as an id stays: it may be the person's own data. A keyed value that is no id shape (`"1"`, `"main"`) is masked only under its key. Other text is left alone.
 * `done` holds the masks `premasked` already wrote.
 */
const idMaskerOf = (texts: readonly string[], sessions: ReadonlyMap<string, string>, indexKey: string, buyerKey: string, done: ReadonlySet<string>): IdMasker => {
  const found = new Map<string, string>();
  for (const text of texts) {
    for (const line of text.split('\n')) lineIdsOf(parsed(line), found);
    // A key ending in `uuid` (or another id key) inside a quoted settings file or tool output: no line carries it as a key, but its value is the same kind of id.
    for (const [, key, id] of text.matchAll(QUOTED_ID)) if (key !== undefined && id !== undefined && looksLikeId(id)) found.set(id, key);
    // A uuid under `id`, `request` (of a classifier context), or `base` inside JSON written into a string: no line need carry it (t1138).
    for (const { key, pattern } of ESCAPED_KEYED) for (const [, id] of text.matchAll(pattern)) if (id !== undefined && id !== NIL_UUID) found.set(id, key);
  }
  // An id this module already masked (the redactor masks `toolu_` ids with the same function, `premasked` the rest) is kept as it is: masking it again would give the one id a second value.
  const keyed = new Map([...found].filter(([id]) => keyedId(id) && !MASKED_PREFIXED.test(id) && !done.has(id)));
  const lineIds = new Map([...keyed].filter(([id]) => looksLikeId(id)));
  const narrow = underKeys(new Map([...keyed].filter(([id]) => !looksLikeId(id) && !sessions.has(id))));
  const opaque = wholeTokens([...lineIds.keys()].filter((id) => !reachedWhole(id) && !sessions.has(id)));
  const mask = (text: string): string => {
    const whole = opaque === null ? text : text.replace(opaque, (id) => maskOf(indexKey, buyerKey, id));
    const ids = whole.replace(UUID_OR_PREFIXED, (id) => sessions.get(id) ?? (lineIds.has(id) || (HARNESS_ID.test(id) && !MASKED_PREFIXED.test(id)) ? maskOf(indexKey, buyerKey, id) : id));
    return narrow.reduce((rest, { pattern }) => rest.replace(pattern, (_all, lead: string, value: string) => `${lead}${maskOf(indexKey, buyerKey, value)}`), ids);
  };
  const known = new Map([...lineIds, ...[...sessions.keys()].map((session): [string, string] => [session, 'session'])]);
  const scan = (text: string): ReadonlyMap<string, number> => {
    const hits = new Map<string, number>();
    const hit = (key: string): void => void hits.set(key, (hits.get(key) ?? 0) + 1);
    for (const [token] of text.matchAll(UUID_OR_PREFIXED)) {
      const key = known.get(token) ?? known.get(token.toLowerCase());
      // A mask this module wrote has a harness prefix and 24 hex; a raw id of that shape is not issued.
      if (key !== undefined) hit(key);
      else if (HARNESS_ID.test(token) && !/^[A-Za-z]+_[0-9a-f]{24}$/.test(token)) hit('prefixed id');
    }
    if (opaque !== null) for (const [token] of text.matchAll(opaque)) hit(lineIds.get(token) ?? 'id');
    for (const { key, pattern } of narrow) {
      const count = [...text.matchAll(pattern)].length;
      if (count > 0) hits.set(key, (hits.get(key) ?? 0) + count);
    }
    return hits;
  };
  return { ids: lineIds, mask, scan };
};

/** An id of the opaque kind (no uuid or prefixed shape) as it stands in text: a run of id characters, which may begin after a separator inside it (`agent_ref-7f3a9c21`). */
const OPAQUE_RUN = /(?<![A-Za-z0-9])[0-9A-Za-z][0-9A-Za-z._-]{6,}[0-9A-Za-z]/g;

/** The ids of a run, from each place a separator lets one begin: the run itself, then what follows each separator. The offset where the id starts, and the id. */
const opaqueIn = (run: string, ids: ReadonlyMap<string, string>): { at: number; id: string } | undefined => {
  for (let at = 0; at < run.length; at += 1) {
    if (at > 0 && /[A-Za-z0-9]/.test(run[at - 1] ?? '')) continue;
    const id = run.slice(at);
    if (ids.has(id)) return { at, id };
  }
  return undefined;
};

/**
 * The masker for the whole pack, run over every file once it is written (t1138): each raw id that any emitted session masked, under whatever key, is replaced wherever it stands in any other session's text, at
 * any depth of escaping, with the value `maskOf` gives it. One pass per shape over a text, each match looked up in a map; the id set is never looped over per text. A uuid or prefixed id is found by its shape; an opaque
 * id (`ref-7f3a...`, `dlv-11aa...`) by the run of id characters it stands in, and only when it holds a letter, so a numeric string never turns an equal JSON number into hex. `ids` holds only id shapes (`looksLikeId`):
 * a narrow keyed value (`"1"`, `"main"`) stays under its key in its own session.
 */
const packMaskerOf = (ids: ReadonlyMap<string, string>, sessions: ReadonlyMap<string, string>, indexKey: string, buyerKey: string): IdMasker => {
  const opaque = new Map([...ids].filter(([id]) => !reachedWhole(id) && /[A-Za-z]/.test(id) && !sessions.has(id)));
  const known = new Map([...ids, ...[...sessions.keys()].map((session): [string, string] => [session, 'session'])]);
  const knownOf = (token: string): string | undefined => (ids.has(token) ? token : ids.has(token.toLowerCase()) ? token.toLowerCase() : undefined);
  const mask = (text: string): string => {
    const shaped = text.replace(UUID_OR_PREFIXED, (token) => {
      const session = sessions.get(token);
      if (session !== undefined) return session;
      const id = knownOf(token);
      return id !== undefined || (HARNESS_ID.test(token) && !MASKED_PREFIXED.test(token)) ? maskOf(indexKey, buyerKey, id ?? token) : token;
    });
    return opaque.size === 0 ? shaped : shaped.replace(OPAQUE_RUN, (run) => {
      const found = opaqueIn(run, opaque);
      return found === undefined ? run : `${run.slice(0, found.at)}${maskOf(indexKey, buyerKey, found.id)}`;
    });
  };
  const scan = (text: string): ReadonlyMap<string, number> => {
    const hits = new Map<string, number>();
    const hit = (key: string): void => void hits.set(key, (hits.get(key) ?? 0) + 1);
    for (const [token] of text.matchAll(UUID_OR_PREFIXED)) {
      const key = known.get(token) ?? known.get(token.toLowerCase());
      if (key !== undefined) hit(key);
      else if (HARNESS_ID.test(token) && !/^[A-Za-z]+_[0-9a-f]{24}$/.test(token)) hit('prefixed id');
    }
    if (opaque.size > 0) for (const [run] of text.matchAll(OPAQUE_RUN)) { const found = opaqueIn(run, opaque); if (found !== undefined) hit(opaque.get(found.id) ?? 'id'); }
    return hits;
  };
  return { ids, mask, scan };
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

/** The first prompts of an orchestration lead session in any repository: `/loop /orchestrate` and `/orchestrate`. A command is read as its name and arguments, as typed. `/handoff resume` is ordinary work in a child repository, so it is a lead only where an owners entry lists it. */
export const LEAD_PROMPTS: readonly RegExp[] = [/^\/loop\s+(?:\S+\s+)?\/orchestrate\b/, /^\/orchestrate\b/];

const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;

/** The first prompt of a Claude Code transcript as the person typed it: a slash command is its name and arguments (`/handoff resume x`), so a pattern reads what was typed. */
const firstPromptOf = async (path: string): Promise<string | undefined> => {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const row of lines) {
      const entry = parsed(row);
      if (!isRecord(entry) || Reflect.get(entry, 'type') !== 'user' || Reflect.get(entry, 'isMeta') === true) continue;
      const message: unknown = Reflect.get(entry, 'message');
      const text = isRecord(message) ? textOf(Reflect.get(message, 'content')) : undefined;
      if (text === undefined || text.trim() === '') continue;
      const name = COMMAND_NAME.exec(text)?.[1];
      return name === undefined ? text.trim() : `${name} ${COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''}`.trim();
    }
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
};

const isLead = async (runtime: SessionsRuntime, record: { project: string; session: string }, extra: readonly RegExp[], listed: readonly string[]): Promise<boolean> => {
  const main = (await transcriptFilesOf(runtime, record.project, record.session)).find((file) => file.main);
  const prompt = main === undefined ? undefined : await firstPromptOf(main.path);
  if (prompt === undefined) return false;
  return [...LEAD_PROMPTS, ...extra].some((pattern) => pattern.test(prompt)) || listed.some((lead) => prompt === lead || prompt.startsWith(`${lead} `));
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

/** The name of a session's skeleton beside its transcripts, and what its manifest row calls it. */
const SKELETON_FILE = 'skeleton.json';

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

/** A value the store derives with no key of the buyer's, re-derived under the buyer's key: the same input gives a buyer one value, and two buyers two, so no pair of packs joins on it. `length` keeps the wire's shape for it. */
const keyedUnder = (buyerKey: string, kind: string, value: string, length: number): string => createHmac('sha256', buyerKey).update(`${kind}:${value}`).digest('hex').slice(0, length);

/** The store's repo key is a salted hash that is the same in every pack built from one store, so two buyers could join on it: under the buyer's key it differs per buyer, and one buyer still sees one repository as one key. */
const repoKeyUnder = (buyerKey: string, repoKey: string): string => keyedUnder(buyerKey, 'repoKey', repoKey, 16);

const withoutDigests = (tool: SkeletonTool): SkeletonTool => {
  const kept = { ...tool };
  delete kept.digests;
  return kept;
};

/**
 * The skeleton as a buyer holds it: `id` is the match id, never the key the pool deposit would use, and every `repoKey` is the buyer's. No unkeyed hash of content or timing ships (plan S3, lead 14): a tool's
 * `digests` are SHA-256 of the unredacted Edit, MultiEdit, and Write text, so a guess at a masked value could be confirmed against one, and are dropped; a transcript's `merkleRoot` and the batch's `timingPrint` are
 * kept in the wire's shape but re-derived under the buyer's key. Every other value is the wire's own, after its gate.
 */
export const skeletonUnder = (skeleton: SessionSkeleton, matchId: string, buyerKey: string): SessionSkeleton => {
  const framed = <F extends { repoKey?: string }>(frame: F): F => (frame.repoKey === undefined ? frame : { ...frame, repoKey: repoKeyUnder(buyerKey, frame.repoKey) });
  return {
    ...skeleton,
    id: matchId,
    timingPrint: skeleton.timingPrint === null ? null : keyedUnder(buyerKey, 'timingPrint', skeleton.timingPrint, 16),
    transcripts: skeleton.transcripts.map((transcript) => ({
      ...transcript,
      merkleRoot: keyedUnder(buyerKey, 'merkleRoot', transcript.merkleRoot, 64),
      frame: framed(transcript.frame),
      frames: transcript.frames.map(framed),
      prompts: transcript.prompts.map((prompt) => ({ ...prompt, frame: framed(prompt.frame) })),
      tools: transcript.tools.map(withoutDigests),
    })),
  };
};

/** Counts by name. A name comes from a transcript (a model), so the keys of the written object are own properties whatever they are. */
export interface Tally {
  [name: string]: number;
}

/**
 * What the free sample gives away of a lot (plan section 3): the sessions counted by harness, harness version, model, error code, recovery, intervention, prompt class, and turn bucket.
 * Counts only: no row per session and no id of one. `model` and `errorCode` count what the manifest and skeletons hold in total, so a total here is the manifest's.
 */
export interface Census {
  sessions: number;
  /** Sessions per harness. */
  harness: Tally;
  /** Sessions per harness version (a session that ran under two counts in both). */
  harnessVersion: Tally;
  /** Prompts per model, the manifest's `models` summed. */
  model: Tally;
  /** Failed calls per error code, over the main transcript and the subagents'. */
  errorCode: Tally;
  /** Failed calls by what followed: an edit within the next calls, or none. The store derives `fixed`, `worked around`, and `abandoned` from the transcript's error lines, which a loaded store does not hold. */
  recovery: Tally;
  /** Prompts per human intervention, the closed list; a prompt captured before the signal has none and is not counted. */
  intervention: Tally;
  /** Prompts per prompt class. */
  promptClass: Tally;
  /** Sessions per `calls` bucket of their turns, named by the bucket's lowest turn count. */
  turnBucket: Tally;
}

/** Prompts per model over the main transcript and the subagents'; a prompt whose frame names no model is not counted. */
export const modelsOf = (skeleton: SessionSkeleton): Tally => {
  const counts = new Map<string, number>();
  for (const { prompts } of skeleton.transcripts) {
    for (const { frame } of prompts) if (frame.model !== null) counts.set(frame.model, (counts.get(frame.model) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)));
};

export const censusOf = (rows: readonly ManifestRow[], skeletons: readonly SessionSkeleton[]): Census => {
  const tallies = { harness: new Map<string, number>(), harnessVersion: new Map<string, number>(), model: new Map<string, number>(), errorCode: new Map<string, number>(), recovery: new Map<string, number>(), intervention: new Map<string, number>(), promptClass: new Map<string, number>(), turnBucket: new Map<string, number>() };
  const add = (into: Map<string, number>, name: string, by = 1): void => {
    into.set(name, (into.get(name) ?? 0) + by);
  };
  for (const row of rows) {
    add(tallies.harness, row.harness);
    for (const version of new Set(row.harnessVersions)) add(tallies.harnessVersion, version);
    for (const [model, messages] of Object.entries(row.models)) add(tallies.model, model, messages);
    add(tallies.turnBucket, String(floorOf('calls', bucketOf('calls', row.turns))));
  }
  for (const skeleton of skeletons) {
    for (const transcript of skeleton.transcripts) {
      for (const prompt of transcript.prompts) {
        add(tallies.promptClass, prompt.cls);
        if (prompt.intervention !== undefined) add(tallies.intervention, prompt.intervention);
      }
      for (const tool of transcript.tools) {
        if (tool.errorCode !== null) add(tallies.errorCode, tool.errorCode);
        if (tool.recoveryCalls !== undefined) add(tallies.recovery, tool.recoveryCalls.editFollowed ? 'edit followed' : 'no edit followed');
      }
    }
  }
  const sorted = (tally: Map<string, number>): Tally => Object.fromEntries([...tally].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { sessions: rows.length, harness: sorted(tallies.harness), harnessVersion: sorted(tallies.harnessVersion), model: sorted(tallies.model), errorCode: sorted(tallies.errorCode), recovery: sorted(tallies.recovery), intervention: sorted(tallies.intervention), promptClass: sorted(tallies.promptClass), turnBucket: sorted(tallies.turnBucket) };
};

const CWD_SCAN_LINES = 200;

/** A line's working directory: a Claude Code line's `cwd`, or a Codex `session_meta`'s `payload.cwd`. */
const cwdOfLine = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const top: unknown = Reflect.get(parsed, 'cwd');
    if (isText(top) && top !== '') return top;
    const payload: unknown = Reflect.get(parsed, 'payload');
    const inner: unknown = isRecord(payload) ? Reflect.get(payload, 'cwd') : undefined;
    return isText(inner) && inner !== '' ? inner : undefined;
  } catch {
    return undefined;
  }
};

/** The first working directory in the raw main transcript, as the harness wrote it: a redacted copy may have changed the path. A later `cd` moves `cwd`, so only the head is read. */
const firstCwd = async (path: string): Promise<string | undefined> => {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let read = 0;
  try {
    for await (const text of reader) {
      read += 1;
      if (read > CWD_SCAN_LINES) break;
      const cwd = cwdOfLine(text);
      if (cwd !== undefined) return cwd;
    }
    return undefined;
  } finally {
    reader.close();
    stream.destroy();
  }
};

/** The folder git is asked in: the working directory while it exists; else the repository the nearest existing ancestor sits in (a removed worktree sat inside, or beside, the repository it was made from). */
const repositoryRoot = async (git: Git, cwd: string): Promise<string | null> => {
  if (existsSync(cwd)) return cwd;
  let ancestor = dirname(cwd);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
  try {
    const top = (await git(ancestor, ['rev-parse', '--show-toplevel'])).trim();
    return top === '' ? null : top;
  } catch {
    return null;
  }
};

const REMOTE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'ssh:', 'git:'];
/** A path under a home folder or `~name/` names an account on the remote host (`/home/alice/...`, `/Users/alice/...`, `C:/Users/alice/...`). */
const ACCOUNT_PATH = /^\/?(?:[A-Za-z]:\/)?(?:(?:home|Users)\/|~[^/]*\/)/i;
const SCP_REMOTE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;

/**
 * The remote as a buyer may read it, or null. A URL can carry a user name or token (`https://user:token@host/...`); neither is a pointer. Only a network URL or `git@host:path` (any other scp user names an account) is
 * kept: a folder (`C:/Users/<name>/...`, `/home/<name>/...`) or a `file:` URL would put the operator's account name and home path into a manifest that the transcripts' masking never reaches.
 */
const publicRemote = (remote: string): string | null => {
  if (SCP_REMOTE.test(remote)) return remote.startsWith('git@') && !ACCOUNT_PATH.test(remote.slice(remote.indexOf(':') + 1)) ? remote : null;
  try {
    const url = new URL(remote);
    if (!REMOTE_PROTOCOLS.includes(url.protocol) || ACCOUNT_PATH.test(decodeURIComponent(url.pathname))) return null;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return null;
  }
};

/** Git reads `--before` as a date; epoch seconds cannot be misread as a day, a zone, or a locale. */
const epochOf = (ts: string): string => String(Math.floor(Date.parse(ts) / 1000));

/** The newest commit from before `tsFirst`: on each of the session's own branches (local, then `origin/`), then on the remote's default branch. Never `HEAD`, which is whatever is checked out now. */
const startingCommit = async (git: Git, root: string, branches: readonly string[], tsFirst: string | null): Promise<string | null> => {
  if (tsFirst === null || Number.isNaN(Date.parse(tsFirst))) return null;
  const before = `--before=${epochOf(tsFirst)}`;
  const refs = [...branches.filter((branch) => branch !== '' && !branch.startsWith('-') && branch !== 'HEAD' && !branch.endsWith('/HEAD')).flatMap((branch) => [branch, `origin/${branch}`]), 'origin/HEAD'];
  for (const ref of refs) {
    try {
      const found = (await git(root, ['rev-list', '-1', before, ref, '--'])).trim();
      if (found !== '') return found;
    } catch {
      // A ref this repository does not have: the next one.
    }
  }
  return null;
};

const pointerOf = async (git: Git, root: string, branches: readonly string[], tsFirst: string | null): Promise<RepositoryPointer | null> => {
  try {
    const remote = publicRemote((await git(root, ['remote', 'get-url', 'origin'])).trim());
    if (remote === null) return null;
    const pointer = { remote, commit: await startingCommit(git, root, branches, tsFirst) };
    // The row is written after the transcripts' scan, so the same test runs here: a remote that holds a key shape is no pointer.
    return secretIn(JSON.stringify(pointer)) === undefined ? pointer : null;
  } catch {
    return null;
  }
};

/** Whether the remote's default branch holds each sha now (`git branch -r --contains`); null for one it cannot say, never false by default. */
const landedOf = async (git: Git, root: string | null, shas: readonly string[]): Promise<OutcomeCommit[]> => {
  let fallback: string | null = null;
  if (root !== null) {
    try {
      fallback = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    } catch {
      fallback = null;
    }
  }
  const unsaid = (sha: string): OutcomeCommit => ({ sha, landed: null });
  const said: OutcomeCommit[] = [];
  for (const sha of shas) {
    if (root === null || fallback === null || fallback === '') {
      said.push(unsaid(sha));
      continue;
    }
    try {
      const holding = (await git(root, ['branch', '-r', '--contains', sha])).split('\n').map((name) => name.trim());
      said.push({ sha, landed: holding.includes(fallback) });
    } catch {
      said.push(unsaid(sha));
    }
  }
  return said;
};

/** The session's id as its transcript file names it: a Codex or other source's store id is `<harness>-<id>`. */
// Exhaustive over the harnesses that prefix their store ids: a new `Harness` member fails to compile here until it is listed.
const PREFIXED_HARNESSES: { [K in Exclude<Harness, 'claude-code'>]: true } = { cursor: true, codex: true, copilot: true, gemini: true, grok: true, opencode: true, pi: true, 'vscode-copilot': true, otel: true };
const PREFIXED = Object.keys(PREFIXED_HARNESSES);

/** A store id as its transcript file names it, from the id alone: `codex-<id>` is `<id>`. `recipients` matches a query against both forms, as an objection may name either. */
export const bareOf = (session: string): string => {
  const prefix = PREFIXED.find((harness) => session.startsWith(`${harness}-`));
  return prefix === undefined ? session : session.slice(prefix.length + 1);
};

type StoredSession = Awaited<ReturnType<typeof loadStore>>['sessions'][number];
type HarnessRow = NonNullable<(typeof HARNESS_TERMS)[Harness]>;

/** What the rules before the duplicate check decide: the count a session adds to, or what it carries on. */
/** Every count of a pack, flat, by name: what rose while one session was handled says why it was left out. */
const tally = (counts: PackCounts): Map<string, number> => new Map([...Object.entries(counts), ...Object.entries(counts.excluded)].flatMap(([key, count]): [string, number][] => (typeof count === 'number' ? [[key, count]] : [])));

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
  const { objections, hash: objectionsHash } = await readObjections(dirname(resolve(options.owners)));
  const objectedSessions = new Set(objections.flatMap(({ session }) => (session === undefined ? [] : [session])));
  const isObjected = (record: { session: string; harness?: Harness }): boolean => objectedSessions.has(record.session) || objectedSessions.has(bareOf(record.session));
  const objectedNames = objections.flatMap(({ name }) => (name === undefined ? [] : [squashed(name.trim())]));
  const domains = await readRedactDomains(runtime.storeDir);
  const names = localNames();
  // One injected-block key per buyer: within a pack the same CLAUDE.md gives the same marker, and two buyers' markers cannot be compared.
  const injectedKey = `injected-block:${createHmac('sha256', options.buyerKey).update('injected-block').digest('hex')}`;
  const store = await loadStore(runtime.storeDir);
  // The wire's own gate, as `oars pool deposit` applies it: the operator's redactor and exclusion terms over every name a skeleton carries.
  const gate: WireGate = { redact: makeRedactor(domains), terms: await loadTerms(options.terms) };
  const roots = new Map<string, TranscriptRoot>((await readSkeletons(runtime.storeDir, undefined, true)).skeletons.map(({ session, merkleRoot, leaves }) => [session, { merkleRoot, leaves }]));
  const recordsOf = new Map(sessionsOf(store, roots).map((records) => [records.main.session, records]));
  const read = shellReader(vocabulary(options.vocabDir));
  const git = options.git ?? runGit;
  // The outcome block's inputs, read from the store only when some owner opted in: each main session's last prompt, and the shas its own shell calls made (a subagent's are not attributed to it).
  const lastVerify = new Map<string, { index: number; verify: PromptVerify | null }>();
  const madeBy = new Map<string, string[]>();
  if (owners.some((owner) => owner.pointer)) {
    for (const prompt of store.prompts) {
      if ((lastVerify.get(prompt.session)?.index ?? -1) < prompt.index) lastVerify.set(prompt.session, { index: prompt.index, verify: prompt.verify ?? null });
    }
    for (const tool of store.tools) {
      if (tool.side || tool.session !== tool.parent) continue;
      const shas = madeBy.get(tool.session) ?? [];
      for (const sha of tool.commits ?? []) if (sha !== null && !shas.includes(sha)) shas.push(sha);
      madeBy.set(tool.session, shas);
    }
  }
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
  const shuffled = frame.map((session) => ({ session, rank: order(session.session) })).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)).map(({ session }) => session);
  // `--sessions`: the listed sessions in the file's order in place of the draw. One the store does not know, or that has no user turn, is told of now; the rest meet every rule below.
  const listed = options.sessions === undefined ? undefined : new Set(options.sessions);
  const storeById = new Map(store.sessions.map((session) => [session.session, session]));
  const drawn = listed === undefined ? shuffled : [...listed].flatMap((id) => {
    const record = storeById.get(id);
    if (record === undefined) options.onDrop?.(id, 'notFound');
    else if (record.userTurns === 0) options.onDrop?.(id, 'tooShort');
    return record === undefined || record.userTurns === 0 ? [] : [record];
  });
  const limit = listed === undefined ? options.size : Infinity;
  const counts: PackCounts = { frame: frame.length, scanned: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, noOwner: 0, noHarnessTerms: 0, lead: 0, tooShort: 0, noRepo: 0, duplicate: 0, noSkeleton: 0, noPointer: 0, objected: 0, secret: 0, emitted: 0 };
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
    if (await isLead(runtime, record, options.leadPrompts ?? [], owner.leadPrompts ?? [])) return { left: (c) => { c.lead += 1; } };
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
  const skeletons: SessionSkeleton[] = [];
  const index: IndexRow[] = [];
  // The files written so far, and the raw ids behind every mask the emitted sessions carry (to the key each stood under): what the pass over the whole pack needs.
  const written: string[] = [];
  const packIds = new Map<string, string>();
  await mkdir(partial, { recursive: true });
  // A listed session that is not emitted is told of with the count that rose while it was handled.
  let pending: { session: string; before: Map<string, number>; emitted: number } | undefined;
  const settle = (): void => {
    if (pending === undefined) return;
    const { session, before, emitted } = pending;
    pending = undefined;
    if (counts.emitted > emitted) return;
    const rose = [...tally(counts)].find(([key, count]) => key !== 'scanned' && count > (before.get(key) ?? 0));
    options.onDrop?.(session, rose?.[0] ?? 'notFound');
  };
  for (const record of drawn) {
    settle();
    if (counts.emitted >= limit) break;
    if (listed !== undefined) pending = { session: record.session, before: tally(counts), emitted: counts.emitted };
    counts.scanned += 1;
    // Before this session's own gate: an objection is honored even for a session the other rules would have left out anyway, and it is the first reason counted.
    if (isObjected(record)) {
      counts.objected += 1;
      continue;
    }
    const decided = await earlyOf(record);
    if ('left' in decided) {
      decided.left(counts);
      continue;
    }
    const { owner, harness, terms } = decided.accepted;
    // Read once, on the first session that gets this far. A loser is chosen only among sessions that pass every rule above, so a longer twin that one of them drops never costs the shorter its place; a duplicate's other half may not be drawn at all.
    if (losers === undefined) {
      // An objected session is no member of a group: a longer one that never ships must not cost its shorter replay the place.
      const everyone = frame.filter((record) => !isObjected(record)).map((record) => ({ session: record.session, project: record.project, turns: turnsOf(record), repo: record.repo, record }));
      losers = await duplicatesOf(runtime, everyone, async (member) => 'accepted' in (await earlyOf(member.record)));
    }
    if (losers.has(record.session)) {
      counts.duplicate += 1;
      continue;
    }
    const matchId = matchIdOf(options.buyerKey, serverKeyOf(indexKey, record.session));
    const records = recordsOf.get(record.session);
    const built = records === undefined ? null : skeletonOf(records, matchId, read, contentHash, [], gate);
    if (built === null) {
      counts.noSkeleton += 1;
      continue;
    }
    const skeleton = skeletonUnder(built, matchId, options.buyerKey);
    const skeletonRaw = `${JSON.stringify(skeleton, null, 2)}\n`;
    const files = await transcriptFilesOf(runtime, record.project, record.session);
    const raws = await Promise.all(files.map((file) => readFile(file.path, 'utf8')));
    // The accounts this session's repositories live under: the owners entry's, and what the remote of each working folder names.
    const handles = [...(owner.handles ?? []), ...accountsOf(new Set(raws.flatMap((raw) => [...cwdsOf(raw)])))];
    // Keyed opaque ids, then `msg_` and `req_` ids, go through the keyed mask first: redaction's entropy rule would turn a real one (mixed case, high entropy) into `<secret>` and cut the link between its lines. `toolu_` ids reach the redactor's `toolId` hook.
    const early = premasked(raws, sessionIds, indexKey, options.buyerKey);
    const texts = early.texts.map((raw) => redactTranscript(raw.replace(VENDOR_ID, (id) => maskOf(indexKey, options.buyerKey, id)), domains, names, injectedKey, { handles, toolId: (id) => maskOf(indexKey, options.buyerKey, id), fetchedHosts: true }).text);
    // The person's name is looked for in the raw text, the redacted text, and the decoded strings: a JSON escape hides it from the raw bytes, and redaction decodes a line only when it masks something in it, so the decoding is done here.
    const searched = [...texts, ...raws, ...raws.flatMap(decodedStrings)].map(squashed);
    if (objectedNames.some((name) => searched.some((text) => text.includes(name)))) {
      counts.objected += 1;
      continue;
    }
    const masker = idMaskerOf(texts, sessionIds, indexKey, options.buyerKey, early.masks);
    const masked = texts.map(masker.mask);
    // The skeleton is built from the store, not the transcript: a tool call that named a transcript file by its session id carries that id in its `names`, so it goes through the same masks.
    const skeletonText = masker.mask(skeletonRaw);
    // After redaction and masking, before the first byte is written: a session with a hit leaves no file, manifest row, or index row.
    if ([...masked, skeletonText].some((text) => secretIn(scannable(text)) !== undefined)) {
      counts.secret += 1;
      continue;
    }
    for (const [at, file] of files.entries()) {
      const target = join(partial, 'sessions', matchId, placeOf(file.key, record.session, file.main));
      await mkdir(dirname(target), { recursive: true });
      const body = masked[at] ?? '';
      bytes += Buffer.byteLength(body);
      await writeFile(target, body);
      written.push(target);
    }
    bytes += Buffer.byteLength(skeletonText);
    const skeletonTarget = join(partial, 'sessions', matchId, SKELETON_FILE);
    await writeFile(skeletonTarget, skeletonText);
    written.push(skeletonTarget);
    // After the files are written, before the next session: an id the masks missed (one a JSON escape hides from the raw bytes shows in the decoded strings) stops the build, and the folder stays for a look.
    const left = new Map<string, number>();
    for (const body of [...masked, skeletonText]) for (const [key, count] of masker.scan([body, ...decodedStrings(body)].join('\n'))) left.set(key, (left.get(key) ?? 0) + count);
    if (left.size > 0) {
      const byKey = [...left].map(([key, count]) => `${key}: ${String(count)}`).join(', ');
      throw new PackError(`A raw id is left in the pack (${byKey}). The unfinished pack stays at ${partial}; delete it after a look, fix the masks, then run again.`);
    }
    for (const [id, key] of [...early.ids, ...masker.ids]) if (id !== NIL_UUID) packIds.set(id, key);
    skeletons.push(skeleton);
    let opted: Pick<ManifestRow, 'pointer' | 'outcome'> = {};
    if (owner.pointer) {
      const main = files.find((file) => file.main);
      const cwd = main === undefined ? undefined : await firstCwd(main.path);
      const root = cwd === undefined ? null : await repositoryRoot(git, cwd);
      const pointer = root === null ? null : await pointerOf(git, root, record.branches, record.tsFirst);
      if (pointer === null) counts.noPointer += 1;
      opted = { pointer, outcome: { verify: lastVerify.get(record.session)?.verify ?? null, commits: await landedOf(git, pointer === null ? null : root, madeBy.get(record.session) ?? []) } };
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
      models: modelsOf(skeleton),
      turns: turnsOf(record),
      skeleton: SKELETON_FILE,
      ...opted,
      redactionVersion: REDACTION_VERSION,
      startedAt: record.tsFirst,
      endedAt: record.tsLast,
    });
    counts.emitted += 1;
  }
  settle();
  // Every file again, now that every emitted session's ids are known: an id one session masked under a key is masked wherever another session quotes it, and a raw one that is left stops the build.
  const finisher = packMaskerOf(packIds, sessionIds, indexKey, options.buyerKey);
  for (const target of written) {
    const before = await readFile(target, 'utf8');
    const body = finisher.mask(before);
    if (body !== before) {
      await writeFile(target, body);
      bytes += Buffer.byteLength(body) - Buffer.byteLength(before);
    }
    const left = finisher.scan([body, ...decodedStrings(body)].join('\n'));
    if (left.size > 0) throw new PackError(`A raw id is left in the pack (${[...left].map(([key, count]) => `${key}: ${String(count)}`).join(', ')}). The unfinished pack stays at ${partial}; delete it after a look, fix the masks, then run again.`);
  }
  const manifest = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  bytes += Buffer.byteLength(manifest);
  await writeFile(join(partial, 'manifest.jsonl'), manifest);
  const census = `${JSON.stringify(censusOf(rows, skeletons), null, 2)}\n`;
  bytes += Buffer.byteLength(census);
  await writeFile(join(partial, 'census.json'), census);
  await writeFile(join(partial, 'pack.json'), `${JSON.stringify({ built: new Date().toISOString(), size: listed === undefined ? options.size : counts.emitted, seed: listed === undefined ? options.seed : null, ...(listed === undefined ? {} : { listed: listed.size }), minTurns: options.minTurns, redactionVersion: REDACTION_VERSION, keyId: keyIdOf(options.buyerKey), objections: objectionsHash, counts, bytes, elapsedMs: Date.now() - started }, null, 2)}\n`);
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
  vocabDir?: URL | undefined;
}

const VALUED = new Set(['--terms', '--owners', '--index-key', '--buyer-key', '--out', '--size', '--seed', '--min-turns', '--sessions']);

const parseArgs = (argv: readonly string[]): (Omit<PackOptions, 'sessions' | 'onDrop'> & { sessionsFile?: string }) | string => {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const [flag, value] = [argv[at] ?? '', argv[at + 1]];
    if (!VALUED.has(flag) || value === undefined) return `Unknown or incomplete option: ${flag}`;
    values.set(flag, value);
  }
  const [terms, owners, indexKey, buyerKey, out] = ['--terms', '--owners', '--index-key', '--buyer-key', '--out'].map((flag) => values.get(flag));
  if (terms === undefined || owners === undefined || indexKey === undefined || buyerKey === undefined || out === undefined) return 'Missing a required option.';
  const sessionsFile = values.get('--sessions');
  if (sessionsFile !== undefined && (values.has('--size') || values.has('--seed'))) return '--sessions takes the place of the seeded draw: give it without --size or --seed.';
  const size = Number(values.get('--size') ?? '25');
  if (!Number.isInteger(size) || size < 1) return '--size takes a whole number of 1 or more.';
  const minTurns = Number(values.get('--min-turns') ?? '20');
  if (!Number.isInteger(minTurns) || minTurns < 1) return '--min-turns takes a whole number of 1 or more.';
  return { terms, owners, indexKey, buyerKey, out, size, seed: values.get('--seed') ?? '1', minTurns, ...(sessionsFile === undefined ? {} : { sessionsFile }) };
};

/** The session ids a `--sessions` file lists: one per line, blank lines skipped, each once, in the file's order. */
const sessionsIn = async (file: string): Promise<string[]> => {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) throw new PackError(`Cannot read the --sessions file ${file}.`);
  const ids = [...new Set(text.split(/\r?\n/).map((id) => id.trim()).filter((id) => id !== ''))];
  if (ids.length === 0) throw new PackError(`The --sessions file ${file} lists no session.`);
  return ids;
};

/** The command: 0 when the pack was written, 2 on a usage or input error (nothing written), with counts only on success: no term, path, or transcript text. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    io.print(`${parsed}\n${USAGE}`);
    return 2;
  }
  const { sessionsFile, ...options } = parsed;
  try {
    const sessions = sessionsFile === undefined ? undefined : await sessionsIn(sessionsFile);
    const dropped: string[] = [];
    const counts = await buildPack(io.runtime, { ...options, size: sessions?.length ?? options.size, sessions, onDrop: (session, reason) => dropped.push(`Left out of the list: ${session} ${reason}`), vocabDir: io.vocabDir });
    const { term, noRaw, noTerms, unreadable } = counts.excluded;
    io.print(
      [
        `Wrote ${String(counts.emitted)} sessions to ${options.out} (manifest.jsonl, sessions/<match id>/).`,
        `Scanned ${String(counts.scanned)} of ${String(counts.frame)} in draw order. Excluded: ${String(term)} for a term, ${String(noRaw)} with no raw, ${String(noTerms)} with no term file, ${String(unreadable)} unreadable.`,
        `Left out after the gate: ${String(counts.noOwner)} in a folder no owner entry names, ${String(counts.noHarnessTerms)} from a harness with no terms row, ${String(counts.tooShort)} under ${String(options.minTurns)} turns, ${String(counts.noRepo)} with no repository, ${String(counts.duplicate)} replaying a longer session, ${String(counts.objected)} under an objection, ${String(counts.secret)} holding a secret after redaction.`,
        ...dropped,
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
