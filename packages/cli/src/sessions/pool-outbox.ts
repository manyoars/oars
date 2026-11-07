// The outbox (`oars pool deposit` and `oars pool outbox`): every batch that may leave this machine is first written here, as canonical JSON lines, and `deposit` stops. Nothing in this file
// looks inside a batch except to name its fields, at every depth, for `--explain`; what a batch holds is the projection's business.
import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
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
  cacheRead: 'A bucket of the tokens read from the cache in a prompt, a number, or null when the source never recorded it.',
  cacheWrite: 'A bucket of the tokens written to the cache in a prompt, a number, or null when the source never recorded it.',
  change: 'How far a delta moved, a signed bucket of its metric (a lower bound) in a number from -7 to 7 for calls per session and from -11 to 11 for thinking tokens; never the exact count.',
  cls: 'The class of a prompt, one of a closed list of eight, computed from the kinds of tools it used; never its words.',
  day: 'The UTC calendar day of the session as YYYY-MM-DD, or null; never a time of day.',
  deltaKind: 'How a delta changed what the client ran: added, removed, or changed, one of a closed list the field allows; never a value.',
  deltas: 'The changes the client found between its own before and after windows, each sent once with the session that filled the after window: a kind, a field, a name, a registry, a metric, and a bucketed change; never a session id, a root, a date, or an exact value.',
  durationMs: 'The time of one tool call in milliseconds, exact, a number or null.',
  effort: 'The effort level the model ran at, only when it is a public one; else the literal placeholder.',
  errorCode: 'Why a tool call failed, one class of a closed list: an exit class (0, 1, 2, 126, 127, signal), an HTTP status class, a harness class (user-rejected, interrupted, permission-denied, input-validation, tool-use-error, timeout), or other; null on a call that did not fail or whose harness records no class. Never result text.',
  editFollowed: 'Whether one of the calls that followed a failed call wrote a file, true or false: what followed, never that the failure was fixed.',
  errors: 'A bucket of how many tool calls failed in a prompt, a number.',
  explore: 'A bucket of how many steps of a prompt only looked (read a file, searched files, searched the web, or fetched a page), a number or null; never the exact count.',
  field: 'What a delta is about, one of plugin, package, permissionMode, and effort: the field alone, never its value.',
  flags: 'The flags of a shell command, each a flag name, never its value: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. Capture still drops a subcommand or flag off the pinned vocabulary of its program, so a real session sends no off-list subcommand (null) and no off-list flag; a subcommand or flag the vocabulary lists goes as its name. A multi-letter single-dash flag no public list holds (`-race`) is dropped.',
  fieldsVersion: 'The version of the field list this client builds a batch from: a constant of this client, never a value from a session.',
  format: 'The skeleton format number: a constant of this client, never a value from a session.',
  filled: 'Whether the harness recorded a setup or a tool funnel for the session, true or false; false means the lists beside it are empty because nothing was recorded, not because no tool was in reach.',
  frame: 'Where a session ran: the harness and its version, the model, the effort, the day, the platform, the shell, and the stack, each checked against its closed list, and the reach of the session (see `reach`). On a step it is a number, the position of the frame its call ran in, in the transcript list of frames.',
  edges: 'The edges arriving at a step, each a kind and the position of the step it names, in the same transcript or, for a spawned edge, in the transcript that spawned this one; absent when none arrive.',
  frames: 'The distinct frames a transcript\'s steps ran in, each as a frame above with the reach of the session; a step names one by position.',
  frameworks: 'The frameworks of the project, each from a closed public list; never a path or a name of yours.',
  harness: 'Which harness wrote the session, one of a closed list.',
  harnessVersion: 'The harness version: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. A transcript or prompt frame carries the value capture closed it to (the public name, else `<literal>`), sent as it is; the version of a call, which capture keeps as its line names it, goes as the string after the gate.',
  host: 'The host of a web fetch or search, the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters; null when the step names no host. Capture keeps the host as the address names it, without credentials, path, or query. The pool replaces a host with a keyed hash on arrival and serves it only once enough accounts report it.',
  hour: 'The UTC hour of day, 0 to 23, beside the day; never a minute, a second, or an offset.',
  id: "A hash the client computes per account from the account and the session, so a redeposit replaces and two accounts' sessions cannot be joined. Never the session id.",
  identity: 'What a step called: a shell program with its subcommand and flags, an MCP server and tool, a skill, or a web host, each a name after redaction or `private`; null for an action with none.',
  input: 'A bucket of the input tokens in a prompt, a number, or null when the source never recorded it.',
  kind: 'How an edge came about, one of a closed list: next, spawned, retried, or after-error.',
  keys: 'The input key names of a call, sorted: a public tool\'s from its published list and any other tool\'s only when each passes the name gate; none for a tool that went as private. Names only, never a value.',
  keysDropped: 'A bucket of the key names of a call that were not sent, off a public tool\'s list or kept private by the gate, a number; never the names.',
  intervention: 'Whether a human stepped in after a prompt\'s work and how, one of a closed list: none, after-error (the prompt\'s last call failed), redo (the next prompt edited the same file), revert (the next prompt undid the edit), user-stop (the human rejected a call or interrupted the turn), or unknown; absent when the prompt predates the signal. An outcome row, not a grade; never the next prompt\'s words.',
  language: 'A programming language of the project, from a closed public list, or other for any language off the list, beside its share bucket.',
  languageShare: 'How much of the files a session touched are in one language, one of four buckets: none, under 10 percent, 10 up to 50, or 50 and over; never a count of files.',
  languageShares: 'The share bucket of each language of the project whose share is known; a language with no share is in the languages list alone.',
  languages: 'The programming languages of the project, each from a closed public list.',
  leaves: 'How many lines of a transcript its root covers, a count.',
  merkleRoot: 'The Merkle root of a transcript: a SHA-256 over the hashes of its lines, one root for each transcript, the main one first; never a line.',
  metric: 'What a delta measures, calls per session or thinking tokens, one of a closed list the field fixes.',
  model: 'The model name: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. A transcript or prompt frame carries the value capture closed it to (the public name, else `<literal>`), sent as it is; the model of a call, which capture keeps as its line names it, goes as the string after the gate.',
  ms: 'A bucket of the milliseconds a step took (a lower bound), a number or null; never the exact time.',
  name: 'The name of a package a shell command pulled or a delta removed, as capture kept it: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters. A plugin in a delta is always private, and null when a delta names its field alone.',
  native: 'The name the harness gave the tool: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters.',
  next: 'The actions of up to the next 5 calls of the same prompt after a failed call, each one of the closed list of canonical actions: what followed, never a fix; no command, path, or text.',
  output: 'A bucket of the output tokens in a prompt, a number, or null when the source never recorded it.',
  parent: 'The position of the call that spawned this step, in the tools of the transcript that spawnedIn names, a number, or null.',
  platform: 'The operating system family, one of a closed list.',
  program: 'The program a shell command ran, its basename only: the name as it is after redaction; `private` when redaction changes it, an exclusion term matches it, it is not a name, or it is over 128 characters.',
  prompt: 'Which prompt of the batch a tool call follows, a position in this batch, or null.',
  prompts: 'The prompts of a transcript: each a class, bucketed counts and tokens, and a frame; never their words.',
  pulls: 'The packages a shell command pulled from a registry: the registry, the public package name, and its version.',
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
  tokens: 'A bucket of tokens (a lower bound of the count), a number or null; a step holds one, never the exact count.',
  tool: 'The tool of an MCP call: the name as it is after redaction, beside a server that is not private and in a harness whose spelling delimits the server; else the literal placeholder.',
  tools: 'The tool calls of a transcript, each a status and duration and its steps, in the order they ran; never their targets or arguments.',
  transcripts: 'The main transcript, then each subagent: its frame, prompts, and tool calls, every value checked against its field\'s list or the name shape before the batch is built.',
  usage: 'The tokens of a prompt as buckets (lower bounds): input, cache write, cache read, output, and thinking.',
  usageResponses: 'A bucket of the responses of a prompt that reported usage, what a partial usage sum covers; left out only for a record captured before the coverage existed (capture version 20).',
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
export const removeBatchesExcept = async (outbox: string, kept: ReadonlySet<string>, stamp: string = currentStamp(), only?: string): Promise<number> => {
  const folder = join(outbox, stamp);
  let removed = 0;
  for (const name of await namesIn(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found !== null && !kept.has(found[1] ?? '') && (only === undefined || found[1] === only)) {
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
  hash: string;
  file: string;
  bytes: string;
}

/** The batches built under this client's vocabulary, field list, and skeleton format, and how many of their files no longer hash to their names. An edited file is not printed and cannot be sent: run `deposit` again to rebuild it. */
export const heldBatches = async (outbox: string, stamp: string = currentStamp()): Promise<{ batches: Held[]; edited: number }> => {
  const folder = join(outbox, stamp);
  const batches: Held[] = [];
  let edited = 0;
  for (const name of await namesIn(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found === null) continue;
    const [, key = '', hash = ''] = found;
    const file = join(folder, name);
    const bytes = await unchangedBytes(file, hash);
    if (bytes === undefined) edited += 1;
    else batches.push({ key, hash, file, bytes });
  }
  return { batches, edited };
};

const shownFile = (outbox: string): string => join(outbox, 'shown.log');

/** Records that this hash was printed, one line for each print: the lock below sends only a hash that appears here. */
export const markShown = async (outbox: string, hash: string, at: number): Promise<void> => {
  await mkdirOwnerOnly(outbox);
  await appendFile(shownFile(outbox), `${hash} ${new Date(at).toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
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
 * The lock on a send: a batch goes only if it is in the outbox, its hash was printed, and its file still hashes to that hash. The first check that fails names why. The nightly task sends with `requireShown: false`,
 * because covenant acceptance is its consent and it prints nothing; the other two checks still hold.
 */
export const lockedBatch = async (outbox: string, hash: string, options: { stamp?: string; requireShown?: boolean } = {}): Promise<{ ok: true; file: string; bytes: string } | { ok: false; code: LockRefusal }> => {
  const folder = join(outbox, options.stamp ?? currentStamp());
  const name = (await namesIn(folder)).find((entry) => BATCH_FILE.exec(entry)?.[2] === hash);
  if (name === undefined) return { ok: false, code: 'batch_unknown' };
  if (options.requireShown !== false && !(await wasShown(outbox, hash))) return { ok: false, code: 'batch_not_shown' };
  const file = join(folder, name);
  const bytes = await unchangedBytes(file, hash);
  return bytes === undefined ? { ok: false, code: 'batch_changed' } : { ok: true, file, bytes };
};

/** Folders of an outbox other than the current stamp's: batches built under another vocabulary, field list, or skeleton format. */
const staleFolders = async (outbox: string, stamp: string): Promise<string[]> => {
  const names: string[] = [];
  for (const name of await namesIn(outbox)) {
    if (name !== stamp && STAMP_FOLDER.test(name)) names.push(join(outbox, name));
  }
  return names;
};

const STAMP_FOLDER = /^v[^./]+-[0-9a-f]{8}$/;

const batchesIn = async (folder: string): Promise<number> => (await namesIn(folder)).filter((name) => BATCH_FILE.test(name)).length;

/** Batches in one server's outbox that were built under another vocabulary, field list, or skeleton format: never printed, never sent. */
export const staleBatches = async (outbox: string, stamp: string = currentStamp()): Promise<number> => {
  let count = 0;
  for (const folder of await staleFolders(outbox, stamp)) count += await batchesIn(folder);
  return count;
};

/** Every server's stale batches, for `verify`. */
export const staleBatchesAnywhere = async (storeDir: string, stamp: string = currentStamp()): Promise<number> => {
  const root = join(storeDir, 'pool-outbox');
  let count = 0;
  for (const name of await namesIn(root)) count += await staleBatches(join(root, name), stamp);
  return count;
};

/** Removes one server's stale batches, and returns how many there were. */
export const discardStale = async (outbox: string, stamp: string = currentStamp()): Promise<number> => {
  const count = await staleBatches(outbox, stamp);
  for (const folder of await staleFolders(outbox, stamp)) await rm(folder, { recursive: true, force: true });
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
