// The outbox (`oars pool deposit` and `oars pool outbox`): every batch that may leave this machine is first written here, as canonical JSON lines, and `deposit` stops. Nothing in this file
// looks inside a batch except to name its fields, at every depth, for `--explain`; what a batch holds is the projection's business.
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { appendOwnerOnly, mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { SKELETON_FORMAT, VOCAB_VERSION } from './pool-wire.js';
import { contentHash } from './read.js';

/** What `JSON.stringify` writes for a value, or undefined for one JSON cannot hold (the lib types call this a string always). */
const encoded = (value: unknown): string | undefined => JSON.stringify(value);

/**
 * JSON with keys sorted at every depth, so two writers of one batch write the same bytes. The sorted entries are written out directly: rebuilding an object would put an integer-like key such as `10` before `9` whatever the sort said.
 * A value JSON cannot hold is left out of an object and written as null in an array, as `JSON.stringify` does.
 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => encoded(entry) !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return encoded(value) ?? 'null';
};

/** The batch as one canonical JSON line: sorted keys, no optional whitespace, UTF-8 when written, and a newline at the end. These are the bytes that are hashed, printed, and sent. */
export const canonicalBytes = (batch: unknown): string => `${canonical(batch)}\n`;

/** The most bytes one request of a deposit carries. The pool refuses a request past 1 MiB, so a batch past this goes in parts, each of them under that cap. */
export const PART_BYTES = 512 * 1024;

/**
 * The batch cut into parts of at most `limit` UTF-8 bytes, never inside a character, so the parts join back to exactly the bytes that were hashed. A batch within the limit is one part.
 */
export const partsOf = (bytes: string, limit: number = PART_BYTES): string[] => {
  const parts: string[] = [];
  let part = '';
  let size = 0;
  for (const character of bytes) {
    const width = Buffer.byteLength(character, 'utf8');
    if (size + width > limit) {
      parts.push(part);
      part = '';
      size = 0;
    }
    part += character;
    size += width;
  }
  parts.push(part);
  return parts;
};

export const batchHash = (bytes: string): string => createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex');

/**
 * `oars pool outbox --explain`: one row for each field name a batch holds, at any depth, saying what admits its values. A field with no row fails the command, so a field added to the batch adds its row here.
 * A name that sits at more than one depth (`status`, `harness`, `frame`) has one row that reads true at each.
 */
export const FIELD_ROWS: { readonly [field: string]: string } = {
  action: 'The canonical action of a step, one of a closed list this client holds; never the harness tool text.',
  agentType: 'The type of the subagent whose run holds a step: a built-in type of the harness, else the word custom; null on a step of the main run.',
  allocated: 'Whether the step\'s token figure was divided among the calls of one model response (true) rather than measured for the call alone; absent when measured. A flag only, never a count.',
  argClass: 'The kinds of value a call\'s arguments held, a sorted set of a closed list: path, url, pattern, command, number, flag, text, and none; never a value.',
  argFeatures: 'Each sent key\'s value features, sorted by key: the value\'s size bucket and, for a path, its depth, extension class, and folder kind, for a pattern what it uses; each from a closed list, never the value.',
  argValues: 'Each sent key\'s closed value: a boolean as true or false, or a member of the tool\'s closed list for the key (an output mode, a built-in subagent type); a value off the list is not sent.',
  arm: 'Whether a recommendation reached the asker or was withheld by the holdback, one of a closed list: shown or held. The local row\'s arm, never what was shown.',
  cacheRead: 'A bucket of the tokens read from the cache in a prompt, a number, or null when the source never recorded it.',
  cacheWrite: 'A bucket of the tokens written to the cache in a prompt, a number, or null when the source never recorded it.',
  change: 'How far a delta moved, a signed bucket of its metric (a lower bound) in a number from -7 to 7 for calls per session and from -11 to 11 for thinking tokens; never the exact count.',
  changeKind: 'What changed from the previous call of the same tool in the same prompt, a sorted set from a closed list: same, key-added, key-removed, feature-changed, value-changed, target-changed; never a value.',
  claimed: 'The host class and launcher a trusted machine states for a batch it admitted from a held branch, from its own enrollment record; absent on a batch built and sent from the machine itself. Two closed lists, never a name.',
  cls: 'The class of a prompt, one of a closed list of eight, computed from the kinds of tools it used; never its words.',
  day: 'The UTC calendar day of the session as YYYY-MM-DD, or null; never a time of day.',
  deltaKind: 'How a delta changed what the client ran: added, removed, or changed, one of a closed list the field allows; never a value.',
  deltas: 'The changes the client found between its own before and after windows, each sent once with the session that filled the after window: a kind, a field, a name, a registry, a metric, and a bucketed change; never a session id, a root, a date, or an exact value.',
  digests: 'The digest of the old and new text of an Edit (one pair), a MultiEdit (one pair per edit, in order), or a Write (a new digest only): the first 32 hex digits of the SHA-256 of the exact text, so a line ending is a difference and the same text gives the same digest in any session. Never the text.',
  dirKind: 'The kind of the folders a path argument names, one of a closed list: root, source, test, doc, generated, hidden, other; never a folder name.',
  durationMs: 'The time of one tool call in milliseconds, exact, a number or null.',
  effort: 'The effort level the model ran at, only when it is a public one; else the literal placeholder.',
  enumValue: 'A closed value of one argument: true, false, or a member of its tool\'s closed list for the key.',
  errorCode: 'Why a tool call failed, one class of a closed list: an exit class (0, 1, 2, 126, 127, signal), an HTTP status class, a harness class (user-rejected, interrupted, permission-denied, input-validation, tool-use-error, timeout), or other; null on a call that did not fail or whose harness records no class. Never result text.',
  editFollowed: 'Whether one of the calls that followed a failed call wrote a file, true or false: what followed, never that the failure was fixed.',
  errors: 'A bucket of how many tool calls failed in a prompt, a number.',
  explore: 'A bucket of how many steps of a prompt only looked (read a file, searched files, searched the web, or fetched a page), a number or null; never the exact count.',
  extension: 'The class of a path argument\'s extension, one of a closed list: source, doc, config, data, image, none, other; never the extension or the name.',
  field: 'What a delta is about, one of plugin, package, permissionMode, and effort: the field alone, never its value.',
  flags: 'The flags of a shell command, each a flag name, never its value: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. Capture still drops a subcommand or flag off the pinned vocabulary of its program, so a real session sends no off-list subcommand (null) and no off-list flag; a subcommand or flag the vocabulary lists goes as its name. A multi-letter single-dash flag no public list holds (`-race`) is dropped.',
  fieldsVersion: 'The version of the field list this client builds a batch from: a constant of this client, never a value from a session.',
  format: 'The skeleton format number: a constant of this client, never a value from a session.',
  filled: 'Whether the harness recorded a setup or a tool funnel for the session, true or false; false means the lists beside it are empty because nothing was recorded, not because no tool was in reach.',
  frame: 'Where a session ran: the harness and its version, the model, the effort, the day, the platform, the shell, and the stack, each checked against its closed list, and the reach of the session (see `reach`). On a step it is a number, the position of the frame its call ran in, in the transcript list of frames.',
  edges: 'The edges arriving at a step, each a kind and the position of the step it names, in the same transcript or, for a spawned edge, in the transcript that spawned this one; absent when none arrive.',
  frames: 'The distinct frames a transcript\'s steps ran in, each as a frame above with the reach of the session; a step names one by position.',
  frameworks: 'The frameworks of the project, each from a closed public list; never a path or a name of yours.',
  from: 'The first call of a recommendation\'s window, a position in the main run\'s calls that are not sidechain, a number; with `to`, the calls a recommendation covers. No text and no time.',
  harness: 'Which harness wrote the session, one of a closed list.',
  harnessVersion: 'The harness version: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. A transcript or prompt frame carries the value capture closed it to (the public name, else `<literal>`), sent as it is; the version of a call, which capture keeps as its line names it, goes as the string after the gate.',
  host: 'The host of a web fetch or search, the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters; null when the step names no host. Capture keeps the host as the address names it, without credentials, path, or query. The pool replaces a host with a keyed hash on arrival and serves it only once enough accounts report it.',
  hostClass: 'Where a session on a machine ran, one of a closed list: local, vps, cloud, ci, or hosted; stated by the trusted machine from its own enrollment record, never by the machine that built the batch.',
  hour: 'The UTC hour of day, 0 to 23, beside the day; never a minute, a second, or an offset.',
  id: "A hash the client computes per account from the account and the session (for a machine, from the account's session salt and the session's name), so a redeposit replaces and two accounts' sessions cannot be joined. Never the session id.",
  identity: 'What a step called: a shell program with its subcommand and flags, an MCP server and tool, a skill, or a web host, each a name after redaction or `private`; null for an action with none.',
  input: 'A bucket of the input tokens in a prompt, a number, or null when the source never recorded it.',
  key: 'The key name an argument feature or closed value belongs to: one of the call\'s sent keys.',
  kind: 'How an edge came about, one of a closed list: next, spawned, retried, or after-error; in a name token, what the name is, one of a closed list: file, dir, env, flag, or agent.',
  keys: 'The input key names of a call, sorted: a public tool\'s from its published list and any other tool\'s only when each passes the name gate; none for a tool that went as private. Names only, never a value.',
  keysDropped: 'A bucket of the key names of a call that were not sent, off a public tool\'s list or kept private by the gate, a number; never the names.',
  intervention: 'Whether a human stepped in after a prompt\'s work and how, one of a closed list: none, after-error (the prompt\'s last call failed), redo (the next prompt edited the same file), revert (the next prompt undid the edit), user-stop (the human rejected a call or interrupted the turn), or unknown; absent when the prompt predates the signal. An outcome row, not a grade; never the next prompt\'s words.',
  language: 'A programming language of the project, from a closed public list, or other for any language off the list, beside its share bucket.',
  languageShare: 'How much of the files a session touched are in one language, one of four buckets: none, under 10 percent, 10 up to 50, or 50 and over; never a count of files.',
  languageShares: 'The share bucket of each language of the project whose share is known; a language with no share is in the languages list alone.',
  languages: 'The programming languages of the project, each from a closed public list.',
  launcher: 'What started a session on a machine whose batch a trusted machine admitted, one of a closed list: interactive, orchestrated, scheduled, ci, hosted-run, or unknown; stated by the trusted machine from its own enrollment record, never by the machine that built the batch.',
  leaves: 'How many lines of a transcript its root covers, a count.',
  merkleRoot: 'The Merkle root of a transcript: a SHA-256 over the hashes of its lines, one root for each transcript, the main one first; never a line.',
  metric: 'What a delta measures, calls per session or thinking tokens, one of a closed list the field fixes.',
  model: 'The model name: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. A transcript or prompt frame carries the value capture closed it to (the public name, else `<literal>`), sent as it is; the model of a call, which capture keeps as its line names it, goes as the string after the gate.',
  ms: 'A bucket of the milliseconds a step took (a lower bound), a number or null; never the exact time.',
  name: 'The name of a package a shell command pulled or a delta removed, or a name token of a call (a file, folder, or variable name), as capture kept it: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters (a name token that fails is dropped and counted, never sent as `private`). A plugin in a delta is always private, and null when a delta names its field alone.',
  native: 'The name the harness gave the tool: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters.',
  names: 'The name tokens of a call\'s values, sorted by kind and name: file names, the names of the folders of a path below the session root, environment variable names, flag values that are names, and a custom agent\'s name, each with its kind. A name is sent as written, so it can identify a project; one the redactor changes, an exclusion term matches, or that is not a name is dropped; never a value, a path, or a command.',
  namesDropped: 'A bucket of the name tokens of a call that were not sent, because the redactor changes them, an exclusion term matches them, or they are not names, a number; never the names.',
  new: 'The digest of the text an edit wrote, 32 hex digits, in a digest pair; never the text.',
  templates: 'One template per shell command of a call, in the order the commands run: its program\'s base name in lower case, without a Windows launcher suffix, its subcommand where the program\'s own public list has one, and its flags that are on the public list or one letter, as written, and every other word as a slot (`<text>`, `<path>`, `<ident>`, `<num>`, `<url>`, `<var>`, `<flag>`), so `git commit -m <text>` and `pytest <path> -k <ident>`; a program given as a path is `<path>`, and the word after a credential, text, or one-letter flag (but `-k` on pytest) is `<text>`. A kept word is sent as written, so it can identify a project; a template with a word the redactor changes, an exclusion term matches, or that is not a name is dropped whole; never an argument, a path, or a value.',
  diffShape: 'What an edit did, a sorted set from a closed list: import-added, import-removed, identifier-renamed, lines-added, lines-removed, lines-changed, whitespace-only, file-written. The shape of the change, read on the machine from the old and new text; never the text, a line, or a name.',
  templatesDropped: 'A bucket of the templates of a call that were not sent, because a program, subcommand, or flag in them is changed by the redactor, matched by an exclusion term, or not a name, a number; never the templates.',
  next: 'The actions of up to the next 5 calls of the same prompt after a failed call, each one of the closed list of canonical actions: what followed, never a fix; no command, path, or text.',
  old: 'The digest of the text an edit replaced, 32 hex digits, in a digest pair; absent for a Write, whose call does not hold the file\'s earlier text, and never the digest of an empty string.',
  output: 'A bucket of the output tokens in a prompt, a number, or null when the source never recorded it.',
  parent: 'The position of the call that spawned this step, in the tools of the transcript that spawnedIn names, a number, or null.',
  pathDepth: 'How many folders a path argument sits below the repository or the working folder, a bucket: 0, 1, 2, 3-4, 5-8, over-8, or outside for an absolute path under neither; never the path.',
  patternFeatures: 'What a pattern argument uses, a sorted set from a closed list: alternation, anchor, class, escape, group, literal, quantifier, recursive, wildcard; never the pattern.',
  platform: 'The operating system family, one of a closed list.',
  poolVersion: 'The deposit time of the pool snapshot a recommendation answered from, as the local row holds it.',
  program: 'The program a shell command ran, its basename only: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters.',
  prompt: 'Which prompt of the batch a tool call follows, a position in this batch, or null.',
  prompts: 'The prompts of a transcript: each a class, bucketed counts and tokens, and a frame; never their words.',
  pulls: 'The packages a shell command pulled from a registry: the registry, the public package name, and its version.',
  recommendations: 'The recommendations the main session was shown or held back from, each an id, an arm, the pool version it answered from, and a window of calls; never the query, the text shown, or the evidence. Absent when the session had none, which the pool reads as unknown exposure, never as unexposed.',
  recoveryCalls: 'For a failed call, what followed it: the actions of up to its next 5 calls and whether one wrote a file. Absent on a call that did not fail; never a signature or text.',
  registry: 'Which registry a pull or a removed package came from, one of a closed list; null for a delta whose name is private or absent.',
  remainingTokens: 'A bucket of the tokens the run spent after a step (a lower bound), a number, or null when steps follow and none reported tokens: the bucket of the exact sum, with the subagent runs a main-run step spawned later in the session.',
  server: 'The MCP server a call went to: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters.',
  shell: 'The shell a command ran in, one of a closed list, or null.',
  side: 'Whether a tool call ran as a side call, true or false.',
  spawnedIn: 'The position, among the transcripts of the batch, of the transcript that spawned this one, a number; null for the main run and for a subagent whose spawner the batch does not hold.',
  size: 'A size class of the repository, one of a closed list, or null; never a count of files.',
  mcp: 'The MCP servers in reach of a session (offered, loaded, or called), each the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters, sorted; never a tool, an argument, or a path.',
  orgSize: 'How many people the operator\'s organization has, one of a closed list of bands or unknown; set by the operator on this machine, never looked up.',
  plugins: 'The plugins in reach of a session, each the word private, since no plugin list is pinned; their number, never their names.',
  reach: 'The MCP servers, skills, and plugins in reach of a session, and whether the harness recorded them; every name is the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters (a plugin is always private).',
  repoKey: "A hash of the repository salted with this store's salt: one store's sessions in one repository share it; one account on two machines gets two keys until the account salt lands. 16 hex characters; never a path, a remote, or a name.",
  repoVisibility: 'Whether the repository is public or private, or unknown; set by the operator on this machine, never looked up.',
  skill: 'The skill a step ran (a skill-run name capture keeps as it is after redaction), or the skill whose run the step\'s call sat in, the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. Absent on a step outside a skill\'s run.',
  skills: 'The skills in reach of a session (called in it), each the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters, sorted.',
  stack: 'The languages, frameworks, and size class of the project.',
  status: 'Whether a tool call or a step succeeded: ok, error, or none.',
  steps: 'The steps of a tool call, each an action in closed vocabulary with its bucketed cost and spawner.',
  team: 'Whether the repository\'s local git log shows one commit author or several, or unknown; a count taken on this machine and dropped, never an author.',
  sub: 'The subcommand of a shell program, or null: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. Capture still drops a subcommand or flag off the pinned vocabulary of its program, so a real session sends no off-list subcommand (null) and no off-list flag; a subcommand or flag the vocabulary lists goes as its name.',
  thinking: 'A bucket of the thinking tokens in a prompt, a number, or null when the source never recorded it.',
  target: 'The position of the step an edge names, a number counted over the steps of one transcript in call order.',
  targetClass: 'The class of the path a call touched, one of a closed list: source, test, config, doc, lockfile, generated, data, none, other; never the path or its name.',
  timingPrint: 'A hash of the call durations of the main transcript in the order they ran, or null under 50 timed calls; the calls of a subagent are not in it.',
  to: 'The end of a recommendation\'s window, one past its last call, a position in the main run\'s calls that are not sidechain, a number; with `from`, the calls a recommendation covers.',
  tokens: 'A bucket of tokens (a lower bound of the count), a number or null; a step holds one, never the exact count.',
  tool: 'The tool of an MCP call: the name as it is after redaction, beside a server that is not private and in a harness whose spelling delimits the server; else the literal placeholder.',
  tools: 'The tool calls of a transcript, each a status and duration and its steps, in the order they ran; never their targets or arguments.',
  transcripts: 'The main transcript, then each subagent: its frame, prompts, and tool calls, every value checked against its field\'s list or the name shape before the batch is built.',
  usage: 'The tokens of a prompt as buckets (lower bounds): input, cache write, cache read, output, and thinking.',
  usageResponses: 'A bucket of the responses of a prompt that reported usage, what a partial usage sum covers; left out only for a record captured before the coverage existed (capture version 20).',
  valueSize: 'The size of an argument\'s value as written, a bucket of its length: 0, 1-8, 9-32, 33-128, 129-512, 513-2k, 2k-8k, over-8k; never the value.',
  version: 'The version of a pulled package, only when it is a registry version; else the literal placeholder or null.',
  vocabVersion: 'The version of the closed vocabulary this client built the batch under: a constant of this client, never a value from a session.',
  wallSec: 'A bucket of the seconds a prompt took, or null.',
};

/**
 * Every field name a batch holds, at any depth, sorted: the rows above. A batch is filed under this list, the skeleton format, and `VOCAB_VERSION`, so one built under an older list, form, or vocabulary is never printed or sent.
 * A test holds this list equal to the fields of a real batch, so a field the sample holds without its row fails there.
 */
export const BATCH_FIELDS: readonly string[] = Object.keys(FIELD_ROWS).sort();

const fieldsStamp = (fields: readonly string[], format: number): string => createHash('sha256').update(`${String(format)}:${fields.join(',')}`).digest('hex').slice(0, 8);

/** The folder name of the batches this client builds now. A folder of any other name holds batches built under an older vocabulary, field list, or skeleton format. */
export const currentStamp = (fields: readonly string[] = BATCH_FIELDS, format: number = SKELETON_FORMAT): string => `v${VOCAB_VERSION}-${fieldsStamp(fields, format)}`;

/** One server's outbox: batches are per server, since a printed batch carries that server's credential. */
export const outboxFolder = (storeDir: string, server: string): string => join(storeDir, 'pool-outbox', contentHash(server));

const BATCH_FILE = /^([0-9a-f]{16})\.([0-9a-f]{64})\.jsonl$/;

/** Writes one session's batch under the current stamp. A session has one batch: an older batch of it is removed, and an identical one is written again, so an edited file is restored. */
export const writeBatch = async (outbox: string, key: string, batch: unknown, stamp: string = currentStamp()): Promise<{ hash: string; folder: string; bytes: number }> => {
  const bytes = canonicalBytes(batch);
  const hash = batchHash(bytes);
  const folder = join(outbox, stamp);
  await mkdirOwnerOnly(folder);
  for (const name of await readdir(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found?.[1] === key && found[2] !== hash) await rm(join(folder, name), { force: true });
  }
  await writeOwnerOnly(join(folder, `${key}.${hash}.jsonl`), bytes);
  return { hash, folder, bytes: Buffer.byteLength(bytes) };
};

export const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** A path that is missing, or has a file where a folder should be, holds nothing. */
const isAbsent = (error: unknown): boolean => isMissing(error) || (error instanceof Error && 'code' in error && error.code === 'ENOTDIR');

/** The names in a folder; a folder that does not exist yet holds none. */
const namesIn = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder)).sort();
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
};

/** Removes every batch under this stamp whose session is not in `kept`, and returns how many went. A session that fails a gate, leaves the allowlist, or is gone from the store never enters the outbox, so an earlier pass's batch of it cannot stay. */
export const removeBatchesExcept = async (outbox: string, kept: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>), stamp: string = currentStamp(), only?: string): Promise<number> => {
  const folder = join(outbox, stamp);
  let removed = 0;
  const names = await namesIn(folder);
  // A reader is asked once the names are in hand: a key it reads then covers every batch listed above.
  const keep = typeof kept === 'function' ? await kept() : kept;
  for (const name of names) {
    const found = BATCH_FILE.exec(name);
    if (found !== null && !keep.has(found[1] ?? '') && (only === undefined || found[1] === only)) {
      await rm(join(folder, name), { force: true });
      removed += 1;
    }
  }
  return removed;
};

/** Removes the batch of one session, if it has one under this stamp, and returns how many files went. */
export const removeBatchOf = async (outbox: string, key: string, stamp: string = currentStamp()): Promise<number> => removeBatchesExcept(outbox, new Set(), stamp, key);

/** The bytes of a batch file, when they still hash to the name the file was written under; undefined when the file is gone or was edited. */
export const unchangedBytes = async (file: string, hash: string): Promise<string | undefined> => {
  let bytes: string;
  try {
    bytes = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return batchHash(bytes) === hash ? bytes : undefined;
};

export interface Held {
  /** The session's key in the outbox (the batch's account-hashed id). */
  key: string;
  /** The stamp folder the batch is filed under. */
  stamp: string;
  /** Whether `oars pool hold pull` admitted it (its key is listed in `pulled.json` at this stamp), as against a batch this machine built. */
  pulled: boolean;
  hash: string;
  file: string;
  bytes: string;
}

/**
 * The batches filed under this stamp, and how many of their files no longer hash to their names. An edited file is not printed and cannot be sent: run `deposit` again to rebuild it. Under the current stamp that is every batch this client built;
 * under any other stamp it is only a batch `pulled.json` lists there, since anything else in that folder is stale and is never printed or sent.
 */
export const heldBatches = async (outbox: string, stamp: string = currentStamp()): Promise<{ batches: Held[]; edited: number }> => {
  const folder = join(outbox, stamp);
  const listed = await pulledAt(outbox, stamp);
  const here = stamp === currentStamp();
  const batches: Held[] = [];
  let edited = 0;
  for (const name of await namesIn(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found === null) continue;
    const [, key = '', hash = ''] = found;
    if (!here && !listed.has(key)) continue;
    const file = join(folder, name);
    const bytes = await unchangedBytes(file, hash);
    if (bytes === undefined) edited += 1;
    else batches.push({ key, stamp, pulled: listed.has(key), hash, file, bytes });
  }
  return { batches, edited };
};

/** The stamps a send reads: the current one, then every other stamp `pulled.json` lists. A listed name that is not a stamp folder is not a path this reads. */
export const sendStamps = async (outbox: string): Promise<string[]> => {
  const others = new Set(Object.values(await readPulled(outbox, POOL_STEP)).filter((stamp) => stamp !== currentStamp() && STAMP_FOLDER.test(stamp)));
  return [currentStamp(), ...[...others].sort()];
};

/** `heldBatches` over every stamp a send reads, the current one first. */
export const heldAcross = async (outbox: string): Promise<{ batches: Held[]; edited: number }> => {
  const all: Held[] = [];
  let edited = 0;
  for (const stamp of await sendStamps(outbox)) {
    const held = await heldBatches(outbox, stamp);
    all.push(...held.batches);
    edited += held.edited;
  }
  return { batches: all, edited };
};

/** The held batch of one session under this stamp, read whole only when its file still hashes to its name; undefined when the session has none, or its file was edited. */
export const heldBatchOf = async (outbox: string, key: string, stamp: string = currentStamp()): Promise<Omit<Held, 'stamp' | 'pulled'> | undefined> => {
  const folder = join(outbox, stamp);
  for (const name of await namesIn(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found?.[1] !== key) continue;
    const hash = found[2] ?? '';
    const file = join(folder, name);
    const bytes = await unchangedBytes(file, hash);
    if (bytes !== undefined) return { key, hash, file, bytes };
  }
  return undefined;
};

const machineKeysFile = (outbox: string): string => join(outbox, 'machine-keys.log');

/** The batch keys a machine's Stop built, one per line. A person's `oars pool deposit` shares the outbox and cannot recompute them (the machine's name is in the key), so its sweep keeps these instead of treating them as batches of sessions the store lost. */
export const machineKeys = async (outbox: string): Promise<Set<string>> => {
  try {
    return new Set((await readFile(machineKeysFile(outbox), 'utf8')).split('\n').filter((line) => line !== ''));
  } catch (error) {
    if (isAbsent(error)) return new Set();
    throw error;
  }
};

/** Notes that a machine built this key; a key already noted adds no line. */
export const noteMachineKey = async (outbox: string, key: string): Promise<void> => {
  if ((await machineKeys(outbox)).has(key)) return;
  await mkdirOwnerOnly(outbox);
  await appendOwnerOnly(machineKeysFile(outbox), `${key}\n`);
};

const shownFile = (outbox: string): string => join(outbox, 'shown.log');

/** Records that this hash was printed, one line for each print: the lock below sends only a hash that appears here. */
export const markShown = async (outbox: string, hash: string, at: number): Promise<void> => {
  await mkdirOwnerOnly(outbox);
  await appendOwnerOnly(shownFile(outbox), `${hash} ${new Date(at).toISOString()}\n`);
};

const wasShown = async (outbox: string, hash: string): Promise<boolean> => {
  try {
    return (await readFile(shownFile(outbox), 'utf8')).split('\n').some((line) => line.split(' ')[0] === hash);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

export type LockRefusal = 'batch_unknown' | 'batch_not_shown' | 'batch_changed';

/**
 * The lock on a send: a batch goes only if it is in the outbox, its hash was printed, and its file still hashes to that hash. The first check that fails names why. The detached sender (hook-bin.js nightly) sends with `requireShown: false`,
 * because covenant acceptance is its consent and it prints nothing; the other two checks still hold.
 */
export const lockedBatch = async (outbox: string, hash: string, options: { stamp?: string; requireShown?: boolean } = {}): Promise<{ ok: true; file: string; bytes: string } | { ok: false; code: LockRefusal }> => {
  const stamp = options.stamp ?? currentStamp();
  const folder = join(outbox, stamp);
  // Under any stamp but the current one, only a pulled batch is a batch: the rest of that folder is stale.
  const listed = stamp === currentStamp() ? undefined : await pulledAt(outbox, stamp);
  const name = (await namesIn(folder)).find((entry) => {
    const found = BATCH_FILE.exec(entry);
    return found?.[2] === hash && (listed === undefined || listed.has(found[1] ?? ''));
  });
  if (name === undefined) return { ok: false, code: 'batch_unknown' };
  if (options.requireShown !== false && !(await wasShown(outbox, hash))) return { ok: false, code: 'batch_not_shown' };
  const file = join(folder, name);
  const bytes = await unchangedBytes(file, hash);
  return bytes === undefined ? { ok: false, code: 'batch_changed' } : { ok: true, file, bytes };
};

const PULLED = 'pulled.json';

/** The batches `oars pool hold pull` admitted and has not seen sent: each `id` (the outbox key) and the stamp folder it is filed under. */
export interface Pulled {
  [id: string]: string;
}

/** `pulled.json` as it stands; none when the file is missing. A file that is not a list of ids and stamps fails the command that reads it, so nothing is pruned or sent on a guess. */
export const readPulled = async (outbox: string, step: string): Promise<Pulled> => {
  let text: string;
  try {
    text = await readFile(join(outbox, PULLED), 'utf8');
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every((stamp) => typeof stamp === 'string')) {
    throw new CliError(`${join(outbox, PULLED)} is not a list of ids and stamps. Move it aside and run the command again; nothing was changed.`, ExitCode.INVALID, step);
  }
  return Object.fromEntries(Object.entries(value).map(([id, stamp]) => [id, String(stamp)]));
};

/** Staged and renamed, so a crash leaves the whole old file or the whole new one. */
export const writePulled = async (outbox: string, pulled: Pulled): Promise<void> => {
  await mkdirOwnerOnly(outbox);
  const staged = join(outbox, `${PULLED}.tmp`);
  await writeOwnerOnly(staged, `${JSON.stringify(Object.fromEntries(Object.entries(pulled).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`);
  await rename(staged, join(outbox, PULLED));
};

const POOL_STEP = 'pool-outbox';

/** Whether any string or key in `value` holds one of `terms`, compared lowercased the way the local gate compares a transcript. */
export const holdsTerm = (value: unknown, terms: readonly string[]): boolean => {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return terms.some((term) => lower.includes(term));
  }
  if (Array.isArray(value)) return value.some((entry) => holdsTerm(entry, terms));
  if (typeof value === 'object' && value !== null) return Object.entries(value).some(([key, entry]) => holdsTerm(key, terms) || holdsTerm(entry, terms));
  return false;
};

/**
 * The exclusion rescan of a send pass: every pulled batch is read against the trusted machine's current term file, and one that now holds a term is removed, with its `pulled.json` entry, and its hash returned. A batch can wait as long as the covenant
 * stays closed, so the terms it was admitted under may not be the terms now. With no terms (a missing or empty file) nothing can be checked: `open` is false, nothing is removed, and the caller sends no pulled batch.
 */
export const rescanPulled = async (outbox: string, terms: readonly string[]): Promise<{ open: boolean; removed: string[] }> => {
  if (terms.length === 0) return { open: false, removed: [] };
  const pulled = await readPulled(outbox, POOL_STEP);
  const removed: string[] = [];
  for (const [id, stamp] of Object.entries(pulled)) {
    const held = STAMP_FOLDER.test(stamp) ? await heldBatchOf(outbox, id, stamp) : undefined;
    // The file is canonical JSON this client wrote, and its bytes just hashed to its name.
    if (held === undefined || !holdsTerm(JSON.parse(held.bytes), terms)) continue;
    await rm(held.file, { force: true });
    Reflect.deleteProperty(pulled, id);
    removed.push(held.hash);
  }
  if (removed.length > 0) await writePulled(outbox, pulled);
  return { open: true, removed };
};

/** The keys `pulled.json` lists at this stamp: the batches of that folder that no local build made and no stale pass may touch. */
export const pulledAt = async (outbox: string, stamp: string = currentStamp()): Promise<Set<string>> =>
  new Set(Object.entries(await readPulled(outbox, POOL_STEP)).filter(([, at]) => at === stamp).map(([id]) => id));

/** `lockedBatch` over every stamp a send reads: the first stamp that holds the hash answers, whether it locks or refuses. */
export const lockedAcross = async (outbox: string, hash: string, options: { requireShown?: boolean } = {}): ReturnType<typeof lockedBatch> => {
  for (const stamp of await sendStamps(outbox)) {
    const locked = await lockedBatch(outbox, hash, { ...options, stamp });
    if (locked.ok || locked.code !== 'batch_unknown') return locked;
  }
  return { ok: false, code: 'batch_unknown' };
};

/** Folders of an outbox other than the current stamp's: batches built under another vocabulary, field list, or skeleton format. */
const staleFolders = async (outbox: string, stamp: string): Promise<string[]> => {
  const names: string[] = [];
  for (const name of await namesIn(outbox)) {
    if (name !== stamp && STAMP_FOLDER.test(name)) names.push(join(outbox, name));
  }
  return names;
};

/** The name of a stamp folder: a vocabulary version, then eight hex digits of the field list and format. No dot or slash, so a name that matches is one path segment. */
export const STAMP_FOLDER = /^v[^./]+-[0-9a-f]{8}$/;

/** The keys of the batch files in one folder. */
const keysIn = async (folder: string): Promise<string[]> => (await namesIn(folder)).flatMap((name) => BATCH_FILE.exec(name)?.[1] ?? []);

/** The batch files of one stale folder, and which of them a stale pass may touch: a key `pulled.json` lists at this folder's stamp is spared, by key and not by folder, so a local batch sharing the folder is still stale. */
const staleIn = async (folder: string, pulled: Pulled): Promise<string[]> => {
  const stamp = basename(folder);
  return (await keysIn(folder)).filter((key) => pulled[key] !== stamp);
};

/** Batches in one server's outbox that were built under another vocabulary, field list, or skeleton format: never printed, never sent. A pulled batch is not one of them, at the stamp it is listed under. */
export const staleBatches = async (outbox: string, stamp: string = currentStamp()): Promise<number> => {
  const pulled = await readPulled(outbox, POOL_STEP);
  let count = 0;
  for (const folder of await staleFolders(outbox, stamp)) count += (await staleIn(folder, pulled)).length;
  return count;
};

/** Every server's stale batches, for `verify`. */
export const staleBatchesAnywhere = async (storeDir: string, stamp: string = currentStamp()): Promise<number> => {
  const root = join(storeDir, 'pool-outbox');
  let count = 0;
  for (const name of await namesIn(root)) count += await staleBatches(join(root, name), stamp);
  return count;
};

/** Removes one server's stale batches, and returns how many there were. A folder that holds a pulled batch loses only the files of the others; one that holds none goes whole. */
export const discardStale = async (outbox: string, stamp: string = currentStamp()): Promise<number> => {
  const pulled = await readPulled(outbox, POOL_STEP);
  let count = 0;
  for (const folder of await staleFolders(outbox, stamp)) {
    const listed = Object.values(pulled).includes(basename(folder));
    if (!listed) {
      count += (await keysIn(folder)).length;
      await rm(folder, { recursive: true, force: true });
      continue;
    }
    const stale = await staleIn(folder, pulled);
    for (const name of await namesIn(folder)) {
      const found = BATCH_FILE.exec(name);
      if (found === null || stale.includes(found[1] ?? '')) await rm(join(folder, name), { recursive: true, force: true });
    }
    count += stale.length;
  }
  return count;
};

const collect = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collect(entry, into);
    }
  }
};

/** Every field name in a batch, at any depth, each once and sorted. */
export const fieldsOf = (batchBytes: string): string[] => {
  const names = new Set<string>();
  collect(JSON.parse(batchBytes), names);
  return [...names].sort();
};
