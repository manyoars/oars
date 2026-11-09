// `oars pool`: the only part of the sessions code that talks to a remote. The server is the one named by flag or environment, else the Many Oars pool; nothing leaves until a command that sends is run or, after covenant acceptance, the detached sender (hook-bin.js nightly) sends. Sign-in runs the provider's device flow here and reads no harness token; a session leaves only as a skeleton of a closed list of fields, each value redacted first, and only after the exclusion check found it clean. Local capture, recall,
// and reads never come through here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { emitOf } from '../telemetry/emit.js';
import { CliError, exitCodeForProblem, ExitCode, unreachableError } from '../errors.js';
import { compileAllow } from './allow.js';
import { makeCoverage, readCoverageSetting, writeCoverageSetting } from './coverage.js';
import { checkSession, exclusionPaths, lastWritten, loadTerms, transcriptFilesOf, type Reason } from './exclusion.js';
import { localNames, makeRedactor, REDACTION_VERSION, redactTranscript } from './redact.js';
import { recordSend, recordWire, newTally, tallyBatch } from '../telemetry/wire.js';
import { discardStale, FIELD_ROWS, fieldsOf, heldBatches, lockedBatch, markShown, outboxFolder, partsOf, removeBatchesExcept, removeBatchOf, staleBatches, unchangedBytes, writeBatch, type LockRefusal } from './pool-outbox.js';
import { HARNESSES, hasEnded, ORG_SIZES, REPO_VISIBILITIES, SESSION_IDLE_HOURS, isBundleVersion, isHarness, parseSkeleton, sessionsOf, skeletonOf, unpinnedKid, VOCAB_VERSION, verifyBundle, type BundleFloors, type SessionRecords, type TranscriptRoot, type WireGate } from './pool-wire.js';
import { carriedDeltas, heldDeltas, keptDeltas, markDeltasSent, placedOf, sentDeltas } from './pool-delta.js';
import { Masker, printed, TRANSPORT_HEADERS, waitWords, type Outgoing } from './pool-print.js';
import { rawAllowed, sendsOf } from './pool-choices.js';
import { heldRaw, rawParts, removeRawExcept, writeRaw } from './pool-raw.js';
import { SendLockBusy, withSendLock } from './pool-send-lock.js';
import { markSent, sentLog } from './pool-sent.js';
import { shellReader } from './projection.js';
import { isVocabularyExpired, REGISTRY_MAX_AGE_DAYS, VOCAB_SNAPSHOT_DATE } from './public-vocabulary.js';
import { contentHash, FIRST_ORDER_FAMILIES } from './read.js';
import { isObject, keptReplica, loadSignIns, numberIn, replicaFile, signInOf, signInsFile, textIn, type SignIn } from './pool-replica.js';
import { CAPTURE_VERSION, harnessOf as sessionHarness, type Harness } from './schema.js';
import { machineOf, type MachineConfig } from './machine.js';
import { loadStore, localSalt, readRedactDomains, readSkeletons, readState, updatePoolChoices, type SessionsRuntime } from './store.js';
import { runGit, type Git } from './survival.js';
import { vocabulary } from './vocab-load.js';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';

const LOGIN = 'pool-login';
const LOGOUT = 'pool-logout';
export const DEPOSIT = 'pool-deposit';
const OUTBOX = 'pool-outbox';
const POOL_DEPOSITS = '/v1/deposits';
const FETCH = 'pool-fetch';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const POOL_PROVIDERS = ['github', 'google'] as const;
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_EXPIRY_SEC = 900;
/** RFC 8628: a `slow_down` adds five seconds to every poll after it. */
const SLOW_DOWN_MS = 5000;

export { isObject, loadSignIns, textIn };

const usage = (message: string, step: string): CliError => new CliError(message, ExitCode.USAGE, step);

/** The Many Oars pool, used when neither `--server` nor `OARS_POOL_URL` names another. */
export const DEFAULT_POOL_URL = 'https://pool.manyoars.com';

/** `--server`, else `OARS_POOL_URL`, else the Many Oars pool. A token and a session's shape cross this connection, so plain http goes only to this machine. */
export const poolServer = (env: NodeJS.ProcessEnv, step: string, named?: string): string => {
  const given = named ?? (env.OARS_POOL_URL === undefined || env.OARS_POOL_URL === '' ? DEFAULT_POOL_URL : env.OARS_POOL_URL);
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw usage(`The pool server ${given} is not a URL.`, step);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) throw usage(`Refusing the pool server ${given}: it takes https, or plain http only to localhost.`, step);
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw usage(`The pool server ${given} is an origin only: no credentials, path, or query.`, step);
  return url.origin;
};

export const runtimeOf = (deps: RunDeps): SessionsRuntime => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.sessions;
};

export const signedIn = async (deps: RunDeps, storeDir: string, server: string, step: string): Promise<SignIn> => {
  const found = (await loadSignIns(storeDir, step)).find((entry) => entry.server === server);
  if (found === undefined || found.expiresAt <= deps.now()) throw new CliError(`Not signed in to ${server}. Run oars pool login first.`, ExitCode.AUTH, step);
  return found;
};

export interface Reply {
  status: number;
  body: unknown;
  headers: Headers;
}

interface Call {
  body?: unknown;
  /** A body already serialized, sent as it is: a batch from the outbox, whose bytes were hashed and printed. */
  bytes?: string;
  token?: string;
  /** One part of a batch sent in several: its position (from 1), how many there are, and the SHA-256 of the whole batch, which is what keeps the parts one deposit. */
  part?: { index: number; count: number; batch: string };
  /** The ETag of the bundle already kept, so the pool can answer 304 with no bundle. */
  ifNoneMatch?: string;
  /** Set for a command that prints what it sends: the print comes first, with these secrets masked. */
  show?: Masker;
  /** A raw part is a PUT of bytes that are not JSON; every other call is a GET, or a POST when it has a body. */
  method?: 'PUT' | 'DELETE';
  type?: string;
  /** Headers beyond the usual ones (the raw routes state their redaction and capture versions, and the raw consent). */
  extra?: Array<[string, string]>;
}

/** How a request leaves this machine. The command line passes none, so a send goes over the network (`networkSender`); a test passes one to read what would leave. */
export type Sender = (request: Outgoing) => Promise<Reply>;

/** The request exactly as it will be sent: `outbox` prints it, and `ask` hands the same value to `fetch`. */
const outgoing = (deps: RunDeps, server: string, path: string, init: Call): Outgoing => {
  const headers: Array<[string, string]> = [['user-agent', `oars/${deps.version}`], ['accept', 'application/json']];
  if (init.token !== undefined) headers.push(['authorization', `Bearer ${init.token}`]);
  // Node's `fetch` writes `cache-control` and `pragma` itself whenever `if-none-match` is set, so they are named here to be printed.
  if (init.part !== undefined) headers.push(['oars-part', `${String(init.part.index)}/${String(init.part.count)}`], ['oars-batch', init.part.batch]);
  if (init.ifNoneMatch !== undefined) headers.push(['if-none-match', init.ifNoneMatch], ['cache-control', 'no-cache'], ['pragma', 'no-cache']);
  headers.push(...(init.extra ?? []));
  const body = init.bytes ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers.push(['content-type', init.type ?? 'application/json']);
  headers.push(...TRANSPORT_HEADERS);
  return { method: init.method ?? (body === undefined ? 'GET' : 'POST'), url: new URL(path, server), headers, ...(body === undefined ? {} : { body }) };
};

/** One call to the pool. A redirect is an error: it could carry a batch or a token somewhere the checks on the named server never saw. */
export const ask = (deps: RunDeps, step: string, server: string, path: string, init: Call, via?: Sender): Promise<Reply> => {
  const request = outgoing(deps, server, path, init);
  return via === undefined ? send(deps, step, request, init.show) : via(request);
};

/** Prints the request when asked to, then sends exactly those headers and that body. */
const send = async (deps: RunDeps, step: string, request: Outgoing, show: Masker | undefined): Promise<Reply> => {
  if (show !== undefined) deps.io.stderr(`${printed(request, show)}
`);
  let response: Response;
  try {
    response = await fetch(request.url, { method: request.method, headers: request.headers, redirect: 'error', ...(request.body === undefined ? {} : { body: request.body }) });
  } catch (error) {
    throw unreachableError(step, error, request.url.origin);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body, headers: response.headers };
};

/** The sender `deposit --send` uses when none is given: the request goes out over the network as built. The loopback test passes it to read what reaches the socket. */
export const networkSender = (deps: RunDeps, step: string): Sender => (request) => send(deps, step, request, undefined);

/** The server's named refusal, as a failure: its `error` is the problem's code in `--json`. */
const refusal = (step: string, { status, body }: Reply): CliError => {
  const code = isObject(body) ? textIn(body, 'error') : undefined;
  const message = (isObject(body) ? textIn(body, 'message') : undefined) ?? `The pool answered HTTP ${String(status)}.`;
  return new CliError(message, exitCodeForProblem(status, code === undefined ? undefined : { code }), step, { title: message, status, ...(code === undefined ? {} : { code }) });
};

/** What the pool's `POST /v1/login/start` hands back: the code to type, the link to open, how often to poll, how long the code lives, and the handle that names this login at the pool. */
interface Started {
  handle: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresMs: number;
}

const startedOf = ({ body }: Reply): Started => {
  const [handle, userCode, verificationUrl] = isObject(body) ? [textIn(body, 'handle'), textIn(body, 'userCode'), textIn(body, 'verificationUrl')] : [];
  // `openBrowser` parses the link before it returns its promise, so one that cannot parse has to stop here or it throws past the login's catch.
  if (!isObject(body) || handle === undefined || userCode === undefined || verificationUrl === undefined || !URL.canParse(verificationUrl)) throw new CliError('The pool did not start a sign-in.', ExitCode.UNEXPECTED, LOGIN);
  // An interval of 0 or below would poll with no wait and never run out the clock, so it takes the default like a missing one.
  const interval = numberIn(body, 'interval');
  return { handle, userCode, verificationUrl, intervalMs: (interval === undefined || interval <= 0 ? DEFAULT_INTERVAL_SEC : interval) * 1000, expiresMs: (numberIn(body, 'expiresIn') ?? DEFAULT_EXPIRY_SEC) * 1000 };
};

/** Polls the pool until the person approves, and returns the pool's answer with the credential. Time is counted in the waits asked for, so a machine that slept through the code still gets one poll that says it expired. */
const awaitCredential = async (deps: RunDeps, server: string, started: Started, masker: Masker): Promise<Reply> => {
  let { intervalMs } = started;
  for (let waited = 0; waited < started.expiresMs; waited += intervalMs) {
    await deps.sleep(intervalMs);
    const reply = await ask(deps, LOGIN, server, '/v1/login/poll', { body: { handle: started.handle }, show: masker });
    if (reply.status !== 200 || !isObject(reply.body)) throw refusal(LOGIN, reply);
    const status = textIn(reply.body, 'status');
    if (status === 'authorized') return reply;
    if (status === 'slow_down') intervalMs += SLOW_DOWN_MS;
    else if (status === 'expired') break;
    else if (status === 'denied') {
      const title = 'The provider refused the sign-in: access_denied.';
      throw new CliError(title, ExitCode.AUTH, LOGIN, { code: 'login_refused', title });
    } else if (status !== 'pending') throw new CliError('The pool answered a sign-in poll with a state this client does not know.', ExitCode.UNEXPECTED, LOGIN);
  }
  const title = 'The sign-in code expired. Run oars pool login again.';
  throw new CliError(title, ExitCode.AUTH, LOGIN, { code: 'EXPIRED_TOKEN', title });
};

/**
 * `oars pool login` (spec Section 1.4): the pool runs the provider's device flow and this client only shows the code and polls the pool, so no provider token, device code, client ID, or secret is ever here. Every request, which goes to the pool alone,
 * prints before it is sent, with the login handle and the credential masked as `<credential: n bytes>`.
 */
export const poolLogin = async (deps: RunDeps, options: { server?: string | undefined; provider?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, LOGIN, options.server);
  const { provider } = options;
  if (provider === undefined || POOL_PROVIDERS.every((name) => name !== provider)) throw usage(`The provider is one of ${POOL_PROVIDERS.join(', ')}.`, LOGIN);
  const saved = await loadSignIns(storeDir, LOGIN);
  const masker = new Masker();
  const startReply = await ask(deps, LOGIN, server, '/v1/login/start', { body: { provider }, show: masker });
  if (startReply.status !== 200) throw refusal(LOGIN, startReply);
  const started = startedOf(startReply);
  masker.add(started.handle);
  deps.io.stderr(`To sign in, open ${started.verificationUrl}\nand confirm the code ${started.userCode}\n`);
  await deps.openBrowser(started.verificationUrl).catch(() => {
    deps.io.stderr('Could not open a browser; open the link above yourself.\n');
  });
  const reply = await awaitCredential(deps, server, started, masker);
  const signIn = signInOf(isObject(reply.body) ? { ...reply.body, server } : undefined);
  if (signIn === undefined) throw new CliError('The pool answered a sign-in with no account, token, or signing key.', ExitCode.UNEXPECTED, LOGIN);
  const known = saved.find((entry) => entry.server === server);
  // A key is trusted once, here, under the id the pool names it by, and never replaced: a server that swaps the key behind an id it already holds could otherwise sign anything it likes. A server cannot add an id either: a new id enters only in a release of oars (RELEASE_KEYS, docs/pool.md), so a server at this URL that names one is refused.
  const held = known?.signingKeys ?? {};
  for (const [kid, key] of Object.entries(signIn.signingKeys)) {
    if (Object.hasOwn(held, kid) && held[kid]?.x !== key.x) {
      const message = `${server} now signs with a different key than the one pinned for ${kid} at your first login. Nothing was saved. If the pool really did change this key, remove ${server} from ${signInsFile(storeDir)} and sign in again.`;
      throw new CliError(message, ExitCode.AUTH, LOGIN, { code: 'signing_key_changed', title: 'The pool signing key changed.', detail: message });
    }
  }
  const unpinned = known === undefined ? undefined : unpinnedKid(held, signIn.signingKeys);
  if (unpinned !== undefined) {
    const message = `${server} signs with the key ${unpinned}, which this machine never pinned for it and this release of oars does not ship. Nothing was saved. Upgrade with npm install -g @manyoars/oars; if the pool really did rotate its key, remove ${server} from ${signInsFile(storeDir)} and sign in again.`;
    throw new CliError(message, ExitCode.AUTH, LOGIN, { code: 'signing_key_unpinned', title: 'The pool signing key is not pinned.', detail: message });
  }
  // Only the keys already held are kept on a repeat login: a key the server offers under a released id is never stored beside the release's own.
  const pinned: SignIn = { ...signIn, signingKeys: known === undefined ? signIn.signingKeys : held };
  await mkdirOwnerOnly(storeDir);
  await writeOwnerOnly(signInsFile(storeDir), `${JSON.stringify([...saved.filter((entry) => entry !== known), pinned])}\n`);
  return { document: { ok: true, server, account: signIn.account, expiresAt: signIn.expiresAt }, text: `Signed in to ${server} as ${signIn.account}.` };
};

/** The pool is not answering: it could not be reached, or a gateway in front of it says so. */
const poolDown = (status: number): boolean => status === 502 || status === 503 || status === 504;

/**
 * `oars pool logout` (S8): revokes this machine's credential at the pool (`DELETE /v1/login`), then removes the local entry. A pool that cannot be reached does not keep the entry: the person asked to be signed out here, so the entry
 * goes and the output says the credential was not revoked there (it lapses on its own, and a login past the pool's cap revokes the oldest). A refusal for any other reason keeps the entry, so the command can be run again.
 */
export const poolLogout = async (deps: RunDeps, options: { server?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, LOGOUT, options.server);
  const saved = await loadSignIns(storeDir, LOGOUT);
  const known = saved.find((entry) => entry.server === server);
  if (known === undefined) return { document: { ok: true, server, revoked: false, removed: false }, text: `Not signed in to ${server}.` };
  // The request prints before it is sent with the credential masked, as every other pool request does.
  const credential = new Masker();
  credential.add(known.token);
  let reply: Reply | undefined;
  try {
    reply = await ask(deps, LOGOUT, server, '/v1/login', { method: 'DELETE', token: known.token, show: credential });
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== ExitCode.UNREACHABLE) throw error;
  }
  if (reply !== undefined && reply.status !== 204 && reply.status !== 401 && !poolDown(reply.status)) throw refusal(LOGOUT, reply);
  await writeOwnerOnly(signInsFile(storeDir), `${JSON.stringify(saved.filter((entry) => entry !== known))}\n`);
  const revoked = reply?.status === 204;
  const text = revoked
    ? `Signed out of ${server}: the credential is revoked there and removed here.`
    : reply?.status === 401
      ? `Signed out of ${server}: the pool had already revoked the credential, and it is removed here.`
      : `Signed out of ${server} here, but the pool could not be reached, so the credential was not revoked there. It lapses on its own.`;
  return { document: { ok: true, server, revoked, removed: true }, text };
};

/** A send stops here when the server is closed or wants a covenant accepted, before the batch is read for the last time. */
const openCovenant = async (deps: RunDeps, server: string, token: string, accept: string | undefined, via: Sender): Promise<void> => {
  const reply = await ask(deps, DEPOSIT, server, '/v1/covenant', { token }, via);
  if (reply.status !== 200 || !isObject(reply.body)) throw refusal(DEPOSIT, reply);
  const version = textIn(reply.body, 'version');
  if (version === undefined) {
    const title = 'This pool is not taking deposits: its covenant is not published.';
    throw new CliError(title, ExitCode.AUTH, DEPOSIT, { code: 'deposits_closed', title, status: 403 });
  }
  if (accept !== undefined) {
    const accepted = await ask(deps, DEPOSIT, server, '/v1/covenant/accept', { token, body: { version: accept } }, via);
    if (accepted.status !== 200) throw refusal(DEPOSIT, accepted);
    return;
  }
  if (Reflect.get(reply.body, 'accepted') !== true) {
    const title = `Read covenant ${version} of this pool, then rerun with --accept-covenant ${version}.`;
    emitOf(deps)('covenant-shown', { version });
    throw new CliError(title, ExitCode.AUTH, DEPOSIT, { code: 'covenant_not_accepted', title, status: 403 });
  }
};

interface DepositCounts {
  sessions: number;
  /** Batches written to the outbox. Nothing has been sent. */
  batched: number;
  /** Sessions kept out by a session gate, by reason and by count only: never a folder name or a term. */
  excluded: { folder: number; term: number; noRaw: number; noTerms: number; unreadable: number };
  /** Sessions in a folder switched off (`oars pool raw folder ... off`): nothing of them is built or queued. */
  off: number;
  /** The redacted raw copies queued (one per transcript), their bytes, and how many values the redactor masked in them. Counts only. */
  raw: { copies: number; bytes: number; masked: number };
  /** Captured before steps and frames, or with a transcript that has no root, so it holds no closed reading to build. Re-capture would give it one. */
  uncaptured: number;
  /** Passed the gates but has a transcript, main or subagent, that gained a line within `session_idle_hours`: its batch waits until the session has ended. */
  notEnded: number;
  /** Refused by the vocabulary here; the count of those and which fields, never a value. */
  refused: number;
  refusedFields: string[];
  /** Batches built under an older vocabulary, field list, or skeleton format, removed from the outbox. */
  discarded: number;
  /** Batches of an earlier pass whose session no longer passes (a gate, the allowlist, a refusal) or is gone from the store, removed so the outbox holds only what this pass built. */
  withdrawn: number;
}

const excludedKey = (reason: Exclude<Reason, 'clean'>): keyof DepositCounts['excluded'] => (reason === 'no-raw' ? 'noRaw' : reason === 'no-terms' ? 'noTerms' : reason);

/** A deposit answered with this code is sent again: another deposit of the same session landed between the pool's read and its write, and the next one nets against the winner. */
const DEPOSIT_CONFLICT = 'deposit_conflict';
const SEND_ATTEMPTS = 3;

export const vocabularyExpired = (deps: RunDeps): CliError | undefined => {
  if (!isVocabularyExpired(new Date(deps.now()))) return undefined;
  const title = `This oars is out of date: its vocabulary ${VOCAB_VERSION} was taken on ${VOCAB_SNAPSHOT_DATE}, over ${String(REGISTRY_MAX_AGE_DAYS)} days ago. Upgrade with npm install -g @manyoars/oars, then run oars pool deposit again. Your sessions stay on this machine.`;
  return new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code: 'vocabulary_expired', title, status: 409 });
};

const lockMessages: { [code in LockRefusal]: string } = {
  batch_unknown: 'No batch with that hash is in the outbox. Run oars pool outbox to list them.',
  batch_not_shown: 'That batch was never printed. Run oars pool outbox, read it, then send it.',
  batch_changed: 'That batch changed on disk after it was printed, or since it was written, so it was not sent. Run oars pool deposit to build it again, then oars pool outbox to print it.',
};

/** The calls one batch takes, in order: one, or one per part when it is past a request's bytes. `outbox` prints these and `deposit --send` sends these, so what is printed is what is sent. */
const callsOf = (token: string, bytes: string, hash: string): Call[] => {
  const parts = partsOf(bytes);
  return parts.map((piece, at) => ({ token, bytes: piece, ...(parts.length === 1 ? {} : { part: { index: at + 1, count: parts.length, batch: hash } }) }));
};

/** One batch to the pool: a batch past one request's bytes goes in parts, in order, each answered 202 until the last completes the deposit with 201. A part sent again is harmless, so the retry covers every part alike. */
export const postBatch = async (deps: RunDeps, options: { server: string; token: string; bytes: string; hash: string; via: Sender }): Promise<void> => {
  const { server, token, bytes, hash, via } = options;
  const calls = callsOf(token, bytes, hash);
  for (const [at, call] of calls.entries()) {
    let reply = await ask(deps, DEPOSIT, server, POOL_DEPOSITS, call, via);
    for (let attempt = 1; attempt < SEND_ATTEMPTS && reply.status === 409 && isObject(reply.body) && textIn(reply.body, 'error') === DEPOSIT_CONFLICT; attempt += 1) {
      reply = await ask(deps, DEPOSIT, server, POOL_DEPOSITS, call, via);
    }
    // 201 on any part means the deposit already finished (this part is a retry), so the rest need not be sent.
    const ended = reply.status !== 202 || at === calls.length - 1;
    // One send event per batch, on the reply that ends it, whatever number of parts it took.
    if (ended) recordSend(deps, { status: reply.status, code: isObject(reply.body) ? textIn(reply.body, 'error') : undefined, bytes: Buffer.byteLength(bytes) });
    if (reply.status === 201) break;
    if (ended) throw refusal(DEPOSIT, reply);
  }
  emitOf(deps)('deposit', { step: 'send', sent: 1, bytes: Buffer.byteLength(bytes) });
};

/**
 * One redacted raw copy to the pool: its parts by PUT, then the completion, which the pool checks against the SHA-256 in the path. Every request states the redaction and capture versions and that the person said yes to the raw prompt;
 * the caller sends only for a person who did. A part sent again replaces itself, and one for an object that stands writes nothing, so a copy that failed halfway is sent again whole.
 */
export const postRaw = async (deps: RunDeps, options: { server: string; token: string; hash: string; body: string; bytes: number; via: Sender }): Promise<void> => {
  const { server, token, hash, body, bytes, via } = options;
  const extra: Array<[string, string]> = [['oars-redaction-version', REDACTION_VERSION], ['oars-capture-version', CAPTURE_VERSION], ['oars-raw-consent', 'granted']];
  const parts = rawParts(body);
  for (const [at, piece] of parts.entries()) {
    const reply = await ask(deps, DEPOSIT, server, `/v1/raw/${hash}/parts/${String(at + 1)}`, { token, bytes: piece, method: 'PUT', type: 'application/x-ndjson', extra }, via);
    if (reply.status !== 200) throw refusal(DEPOSIT, reply);
  }
  const done = await ask(deps, DEPOSIT, server, `/v1/raw/${hash}/complete`, { token, body: { parts: parts.length, bytes }, extra }, via);
  if (done.status !== 200 && done.status !== 201) throw refusal(DEPOSIT, done);
};

const rawNote = (consent: string | null): string =>
  consent === 'granted' ? '' : consent === 'declined' ? 'You answered no to the raw prompt; oars pool raw --consent yes changes it.' : 'None is queued until you answer the raw prompt with oars pool raw --consent yes.';

/** `deposit --send <hash>`: the send lock the detached sender (hook-bin.js nightly) takes too, then a skip for a hash already in `sent.log`, then the batch lock, then the covenant (accepted here or before, or nothing is sent), then the request. The body is read and hashed again just before the request. */
const sendBatch = async (deps: RunDeps, options: { outbox: string; server: string; token: string; hash: string; acceptCovenant: string | undefined; via: Sender | undefined }): Promise<Outcome> => {
  const { outbox, server, token, hash } = options;
  const via = options.via ?? networkSender(deps, DEPOSIT);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw usage('--send takes the SHA-256 that oars pool outbox printed: 64 hexadecimal characters.', DEPOSIT);
  const refuse = (code: string, title: string): CliError => new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code, title, status: 409 });
  try {
    return await withSendLock(outbox, async () => {
      // The rule the nightly follows: a hash `sent.log` holds is not posted again. Read under the lock, so two runs cannot both see it unsent.
      const sentAt = (await sentLog(outbox)).get(hash);
      if (sentAt !== undefined) return { document: { ok: true, server, hash, sent: false, sentAt }, text: `already sent ${hash} at ${sentAt}` };
      const locked = await lockedBatch(outbox, hash);
      if (!locked.ok) throw refuse(locked.code, lockMessages[locked.code]);
      await openCovenant(deps, server, token, options.acceptCovenant, via);
      const bytes = await unchangedBytes(locked.file, hash);
      if (bytes === undefined) throw refuse('batch_changed', lockMessages.batch_changed);
      await postBatch(deps, { server, token, bytes, hash, via });
      await markSent(outbox, hash, deps.now());
      return { document: { ok: true, server, hash, sent: true }, text: `Sent batch ${hash} to ${server}.` };
    });
  } catch (error) {
    if (error instanceof SendLockBusy) throw refuse('send_locked', 'Another oars run is sending from this outbox. Try again in a minute.');
    throw error;
  }
};

const machineAccount = (machine: MachineConfig): string => `machine:${machine.machine ?? machine.hostClass}`;

/** The outbox key, and the skeleton `id`, of a machine's session: its own name stands in for the account, which a machine has none of. The holding route names its branch by the same key. */
export const machineKeyOf = (machine: MachineConfig, session: string): string => contentHash([machineAccount(machine), session]);

/**
 * `oars pool deposit`: every session in the store that passes both session gates is built into a canonical batch in the outbox, and the command stops: nothing is sent. The gates run before any projection does: the folder
 * allowlist, then the exclusion check. A session that fails either, or has no raw to scan, is counted and never built. A session is built only once it has ended: no transcript of it, main or subagent, has gained a line (the later of its capture
 * and its raw file's last write) for `session_idle_hours` (6 hours). One that has not is counted under `notEnded`, and any batch of it from an earlier pass is withdrawn. `--send <hash>` is the lock in `sendBatch`.
 */
export const poolDeposit = async (
  deps: RunDeps,
  options: { server?: string | undefined; acceptCovenant?: string | undefined; send?: string | undefined; via?: Sender | undefined; git?: Git | undefined; session?: string | undefined },
): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const server = poolServer(deps.env, DEPOSIT, options.server);
  // A machine (`OARS_HOST_CLASS`, see machine.ts) builds at every Stop and sends nothing from here, so it signs nobody in: the account part of its batch key is its own name, and the holding route's `id` replaces it.
  const machine = machineOf(deps.env);
  if (machine !== undefined && options.send !== undefined) throw usage('A machine builds batches into its outbox and sends none: --send is for a signed-in person.', DEPOSIT);
  const { account, token } = machine === undefined ? await signedIn(deps, runtime.storeDir, server, DEPOSIT) : { account: machineAccount(machine), token: '' };
  // A client past `registry_max_age` builds no batch (spec Section 1.3): its sessions wait in `A` and nothing is lost. This comes before anything is written or sent.
  const expired = vocabularyExpired(deps);
  if (expired !== undefined) throw expired;
  // Accepting the covenant is a step of sending a batch: alone it would exit 0 as though something had been sent under it.
  if (options.send === undefined && options.acceptCovenant !== undefined) throw usage('--accept-covenant belongs to --send: it is accepted as a step of sending a batch. Nothing was accepted.', DEPOSIT);
  const outbox = outboxFolder(runtime.storeDir, server);
  await mkdirOwnerOnly(outbox);
  if (options.send !== undefined) return sendBatch(deps, { outbox, server, token, hash: options.send, acceptCovenant: options.acceptCovenant, via: options.via });
  const { terms } = exclusionPaths(runtime.projectsRoot, deps.env);
  const saved = await readState(runtime.storeDir);
  const names = localNames();
  // The key an injected block's hash is made under: this machine's salt, so the same block hashes the same in every session and the key never leaves it.
  const injectedKey = `injected-block:${(await localSalt(runtime.storeDir)).salt}`;
  const allow = compileAllow(saved.allow);
  const discarded = await discardStale(outbox);
  const counts: DepositCounts = { sessions: 0, batched: 0, excluded: { folder: 0, term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, off: 0, raw: { copies: 0, bytes: 0, masked: 0 }, uncaptured: 0, notEnded: 0, refused: 0, refusedFields: [], discarded, withdrawn: 0 };
  // The one gate on a name: the operator's redactor and exclusion terms (t881). Everything else the pool classes itself.
  const gate: WireGate = { redact: makeRedactor(await readRedactDomains(runtime.storeDir)), terms: await loadTerms(terms) };
  const built = new Set<string>();
  const rawKept = new Set<string>();
  // The bytes of the batches written in this pass: telemetry counts them, and the command's own document does not carry them.
  let builtBytes = 0;
  const wireTally = newTally();
  const refusedFields = new Set<string>();
  const roots = new Map<string, TranscriptRoot>((await readSkeletons(runtime.storeDir, undefined, true)).skeletons.map(({ session, merkleRoot, leaves }) => [session, { merkleRoot, leaves }]));
  // The sessions that pass both gates and have ended, in the order the store holds them: the windows of a delta are counted over these alone, and the batch of each is built after, once its deltas are known.
  const ready: { records: SessionRecords; key: string }[] = [];
  // A session that fails a gate loses its earlier batch at once, so a later throw in this pass cannot leave one in the outbox.
  const withdraw = async (key: string): Promise<void> => {
    counts.withdrawn += await removeBatchOf(outbox, key);
    await removeRawExcept(outbox, new Set(), key);
  };
  // The sessions a Stop does not name that still pass the read-only gates: they only fill the windows of a delta, and are never counted, withdrawn, or built.
  const history: SessionRecords[] = [];
  for (const records of sessionsOf(await loadStore(runtime.storeDir), roots)) {
    // The Stop of a machine builds the one session that stopped: the others in the store belong to Stops of their own, so their batches stay as they are. They run the three read-only gates below and no more.
    const named = options.session === undefined || records.main.session === options.session;
    if (named) counts.sessions += 1;
    // Hashed with the account, so a redeposit replaces its own batch and two accounts' copies of one session cannot be joined.
    const key = machine === undefined ? contentHash([account, records.main.session]) : machineKeyOf(machine, records.main.session);
    if (!allow.allows(records.main.project)) {
      if (named) {
        counts.excluded.folder += 1;
        await withdraw(key);
      }
      continue;
    }
    // A folder switched off sends nothing from now on; what it sent before stays where it went.
    if (sendsOf(saved.pool, records.main.project) === 'off') {
      if (named) {
        counts.off += 1;
        await withdraw(key);
      }
      continue;
    }
    const verdict = await checkSession(runtime, terms, records.main.project, records.main.session);
    if (verdict.reason !== 'clean') {
      if (named) {
        counts.excluded[excludedKey(verdict.reason)] += 1;
        await withdraw(key);
      }
      continue;
    }
    if (!named) {
      history.push(records);
      continue;
    }
    // The batch of a session is built once the session and its subagents have ended; a session still in progress waits, and an earlier batch of it is withdrawn. A machine's Stop is the end of a turn, not of a session: its VM may be reclaimed before the session ends, so it builds the open session as it stands.
    if (machine === undefined && !hasEnded(records, deps.now(), await lastWritten(runtime, records.main.project, records.main.session))) {
      counts.notEnded += 1;
      await withdraw(key);
      continue;
    }
    ready.push({ records, key });
  }
  // A delta is built from the sessions that passed, carried by the batch of the session that filled its after window, and marked sent only once that batch is written: a deposit that stops first builds it again.
  // A cloud machine has no history of its own to compare a window against (every VM starts clean), so it carries none.
  const placed = machine?.hostClass === 'cloud' ? [] : [...ready.map(({ records }) => records), ...history].flatMap((records) => placedOf(records) ?? []);
  const carried = carriedDeltas(account, placed, await sentDeltas(outbox));
  // The coverage bands (t871): the operator's two settings, read here, and the team band counted from the local git log. Nothing is looked up, and anything unread goes as unknown.
  const coverageOf = makeCoverage(runtime, await readCoverageSetting(runtime.storeDir), options.git ?? runGit);
  for (const { records, key } of ready) {
    const delta = carried.get(records.main.session);
    // A machine builds the open session at every Stop and SessionEnd, so the one it names keeps what its own earlier batch carried and takes only what is new; any other deposit builds a session once.
    const entries = machine !== undefined && options.session !== undefined ? keptDeltas(await heldDeltas(outbox, key), delta?.entries ?? []) : delta?.entries;
    const skeleton = skeletonOf(records, key, shellReader(vocabulary()), contentHash, entries, gate, await coverageOf(records.main));
    if (skeleton === null) {
      counts.uncaptured += 1;
      await withdraw(key);
      continue;
    }
    const parsed = parseSkeleton(skeleton);
    // The server reads a value outside its lists as `other` and keeps a field it does not know, so the parser no longer refuses either: the emitter is the privacy control, and a batch this client built holds neither.
    const refusedAt = parsed.ok ? parsed.extensions[0]?.at : parsed.field;
    if (!parsed.ok || refusedAt !== undefined) {
      counts.refused += 1;
      refusedFields.add(refusedAt ?? '');
      await withdraw(key);
      continue;
    }
    builtBytes += (await writeBatch(outbox, key, parsed.skeleton)).bytes;
    // The raw copy comes only after both gates and only with a yes to the raw prompt and a folder not at skeleton only: each transcript of the session, redacted here, before it is queued.
    if (rawAllowed(saved.pool, records.main.project)) {
      let place = 0;
      for (const file of await transcriptFilesOf(runtime, records.main.project, records.main.session)) {
        const redacted = redactTranscript(await readFile(file.path, 'utf8'), saved.redactDomains, names, injectedKey);
        counts.raw.bytes += (await writeRaw(outbox, key, place, redacted.text)).bytes;
        counts.raw.copies += 1;
        counts.raw.masked += redacted.masked;
        place += 1;
      }
      rawKept.add(key);
    }
    tallyBatch(wireTally, parsed.skeleton);
    await markDeltasSent(outbox, delta?.marks ?? []);
    built.add(key);
    counts.batched += 1;
  }
  // The batch of a session or account this store no longer holds goes too. A machine builds one session at a time and nothing here has the others in hand, so it sweeps nothing: nothing is withdrawn but what a gate refused.
  if (machine === undefined) {
    counts.withdrawn += await removeBatchesExcept(outbox, built);
    await removeRawExcept(outbox, rawKept);
  }
  counts.refusedFields = [...refusedFields].sort();
  recordWire(deps, wireTally);
  const { folder, term, noRaw, noTerms, unreadable } = counts.excluded;
  // Counts only: how many sessions each gate kept out, never a folder, a term, or a name.
  emitOf(deps)('deposit', { step: 'build', sessions: counts.sessions, batched: counts.batched, bytes: builtBytes, excludedFolder: folder, excludedTerm: term, excludedNoRaw: noRaw, excludedNoTerms: noTerms, excludedUnreadable: unreadable, notEnded: counts.notEnded, uncaptured: counts.uncaptured, refused: counts.refused, withdrawn: counts.withdrawn, discarded });
  const lines = [
    `Wrote ${String(counts.batched)} of ${String(counts.sessions)} sessions to the outbox for ${server}. Nothing was sent.`,
    `Kept out by the session gates, never built: ${String(folder)} in a folder not on the allowlist, ${String(term)} for a term, ${String(noRaw)} with no raw to scan, ${String(noTerms)} with no term file, ${String(unreadable)} unreadable.`,
    `Not built: ${String(counts.uncaptured)} captured before steps and frames or with no root, ${String(counts.notEnded)} not ended (a transcript gained a line within ${String(SESSION_IDLE_HOURS)} hours), ${String(counts.refused)} refused by the vocabulary${counts.refusedFields.length === 0 ? '' : ` (${counts.refusedFields.join(', ')})`}.`,
    ...(counts.withdrawn === 0 ? [] : [`Removed ${String(counts.withdrawn)} ${counts.withdrawn === 1 ? 'batch' : 'batches'} of sessions that no longer pass the gates, have not ended, or are no longer in the store.`]),
    ...(discarded === 0 ? [] : [`Discarded ${String(discarded)} ${discarded === 1 ? 'batch' : 'batches'} built under an older vocabulary, field list, or skeleton format.`]),
    `Raw copies queued: ${String(counts.raw.copies)} (${String(counts.raw.bytes)} bytes, ${String(counts.raw.masked)} values masked). ${rawNote(saved.pool.rawConsent)}`.trim(),
    ...(counts.off === 0 ? [] : [`${String(counts.off)} ${counts.off === 1 ? 'session' : 'sessions'} in a folder switched off: nothing of them is queued.`]),
    'Run oars pool outbox to print exactly what would be sent.',
  ];
  return { document: { ok: true, server, ...counts }, text: lines.join('\n') };
};

/** Each field of a batch, at any depth, with its row. A field with no row fails the command rather than printing blank. */
const explained = (bytes: string): { [field: string]: string } => {
  const rows: { [field: string]: string } = {};
  for (const field of fieldsOf(bytes)) {
    const row = Object.hasOwn(FIELD_ROWS, field) ? FIELD_ROWS[field] : undefined;
    if (row === undefined) {
      const title = `The batch holds a field, ${field}, with no row to explain it. Nothing was printed for it.`;
      throw new CliError(title, ExitCode.INVALID, OUTBOX, { code: 'field_without_row', title });
    }
    rows[field] = row;
  }
  return rows;
};

/** `oars pool outbox`: prints each batch as it would be sent (a batch past one request prints each part's request, in order), the request line and every header included, with the bearer credential as its size and nothing else masked, then its SHA-256, and records that it was shown. `--explain` adds each field's rule. */
export const poolOutbox = async (deps: RunDeps, options: { server?: string | undefined; explain?: boolean | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const server = poolServer(deps.env, OUTBOX, options.server);
  const { token } = await signedIn(deps, runtime.storeDir, server, OUTBOX);
  const outbox = outboxFolder(runtime.storeDir, server);
  const { batches, edited } = await heldBatches(outbox);
  const masker = new Masker();
  masker.add(token);
  const sent = await sentLog(outbox);
  const shown: Array<{ hash: string; request: string; sent?: string; fields?: { [field: string]: string } }> = [];
  for (const batch of batches) {
    const fields = options.explain === true ? explained(batch.bytes) : undefined;
    // A batch past one request prints every part's request, in the order they are sent.
    const request = callsOf(token, batch.bytes, batch.hash).map((call) => printed(outgoing(deps, server, POOL_DEPOSITS, call), masker)).join('\n');
    shown.push({ hash: batch.hash, request, ...(sent.has(batch.hash) ? { sent: sent.get(batch.hash) ?? '' } : {}), ...(fields === undefined ? {} : { fields }) });
  }
  const { copies } = await heldRaw(outbox);
  const rawBlocks = copies.flatMap((copy) =>
    rawParts(copy.body).map((part, at, all) => [`raw part ${String(at + 1)}/${String(all.length)} sha256: ${copy.hash} bytes: ${String(Buffer.byteLength(part))}${sent.has(copy.hash) ? ` sent: ${sent.get(copy.hash) ?? ''}` : ''}`, ...(options.explain === true ? [part] : [])].join('\n')),
  );
  for (const { hash } of shown) await markShown(outbox, hash, deps.now());
  const stale = await staleBatches(outbox);
  const blocks = shown.map(({ hash, request, sent: at, fields }) => [request, `sha256: ${hash}`, ...(at === undefined ? [] : [`sent: ${at}`]), ...Object.entries(fields ?? {}).map(([field, row]) => `  ${field}: ${row}`)].join('\n'));
  const notes = [
    ...(edited === 0 ? [] : [`${String(edited)} ${edited === 1 ? 'batch was' : 'batches were'} edited on disk since ${edited === 1 ? 'it was' : 'they were'} written and ${edited === 1 ? 'is' : 'are'} not printed or sent. Run oars pool deposit to build ${edited === 1 ? 'it' : 'them'} again.`]),
    ...(stale === 0 ? [] : [`${String(stale)} ${stale === 1 ? 'batch was' : 'batches were'} built under an older vocabulary, field list, or skeleton format and will never be sent.`]),
  ];
  const text = shown.length === 0 && rawBlocks.length === 0 ? ['The outbox is empty. Run oars pool deposit first.', ...notes].join('\n') : [...blocks, ...rawBlocks, ...notes].join('\n\n');
  return { document: { ok: true, server, batches: shown, raw: copies.map(({ hash, bytes }) => ({ hash, bytes, ...(sent.has(hash) ? { sent: sent.get(hash) ?? '' } : {}) })), edited, stale }, text };
};

/**
 * What the pool says it served a bundle at, printed as the bundle states it: the client holds no floor of its own and applies none (a floor is the pool's deploy setting), so a bundle that states none prints nothing.
 * A family on a floor of its own is named with it, but only a family this client knows: a key the pool adds later parses and travels in `--json`, and no pool-supplied string reaches the terminal.
 */
const floorSentence = (floors: BundleFloors | undefined): string => {
  if (floors === undefined) return '';
  const own = Object.entries(floors.families ?? {})
    .filter(([family]) => FIRST_ORDER_FAMILIES.some((known) => known === family))
    .map(([family, floor]) => `${family} at ${String(floor)}`);
  return ` The pool served it at a public floor of ${String(floors.public)} clusters and a disclosure floor of ${String(floors.disclosure)}${own.length === 0 ? '' : `, with ${own.join(' and ')}`}.`;
};

/** The weekly cap, as a failure of its own code: the bundle on disk is untouched, and the words say when the pool will answer again. */
const cappedError = (deps: RunDeps, reply: Reply, kept: boolean): CliError => {
  const retryAfter = reply.headers.get('retry-after');
  const wait = retryAfter === null ? undefined : waitWords(retryAfter, deps.now());
  const when = wait === undefined ? 'The pool did not say when; it counts fetches per ISO week, so try again next week.' : `Try again ${wait}.`;
  const title = `The pool's weekly fetch cap is used up. ${when} ${kept ? 'The bundle already on disk is untouched.' : 'No verified bundle is kept.'}`;
  return new CliError(title, ExitCode.CAPPED, FETCH, { code: 'fetch_cap', title, status: 429 }, { retryAfter });
};

/** What a fetch asks for when no `--harness` is given, and what it falls back to when no one harness leads the local store. */
const DEFAULT_HARNESS: Harness = 'claude-code';

/** The harnesses a bundle is served for. `otel` reads the framework into the version slot, so no public bundle is keyed by it (lead 219): it is in `HARNESSES` for the wire, not for a fetch. */
const FETCHABLE: readonly Harness[] = HARNESSES.filter((name) => name !== 'otel');

/**
 * The harness a fetch asks for. `--harness` names it, and nothing is printed. Without the flag it is the harness the local store holds the most sessions of, and the choice and the way to
 * change it go to stderr before the request: a fetch never picks silently. An empty store or a tie asks for Claude Code's and says so. Sessions of a harness with no bundle (`otel`) are not counted. It reads counts only, and none of them leaves the machine.
 */
const fetchHarness = async (deps: RunDeps, storeDir: string, named: string | undefined): Promise<Harness> => {
  if (named !== undefined) {
    if (named === 'otel') throw usage(`otel has no pool bundle. Choose one of ${FETCHABLE.join(', ')}.`, FETCH);
    if (!isHarness(named)) throw usage(`${named} is not a harness the pool serves. Choose one of ${FETCHABLE.join(', ')}.`, FETCH);
    return named;
  }
  const counts = new Map<Harness, number>();
  const sessions = (await loadStore(storeDir)).sessions;
  for (const session of sessions) {
    const harness = sessionHarness(session);
    if (FETCHABLE.includes(harness)) counts.set(harness, (counts.get(harness) ?? 0) + 1);
  }
  const [top, runnerUp] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lead = top !== undefined && (runnerUp === undefined || top[1] > runnerUp[1]) ? top : undefined;
  const harness = lead === undefined ? DEFAULT_HARNESS : lead[0];
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const none = sessions.length === 0 ? 'your local store is empty' : 'your local store holds no session of a harness the pool serves';
  const why = lead === undefined ? `${total === 0 ? none : 'no one harness leads your local store'}, so Claude Code is the default` : `the harness your local store holds the most sessions of (${String(lead[1])} of ${String(total)})`;
  deps.io.stderr(`No --harness given: fetching ${harness}, ${why}. Pass --harness <name> to fetch another (${FETCHABLE.join(', ')}).
`);
  return harness;
};

/** `oars pool fetch`: one harness's signed bundle at one version, kept only once the key pinned at login has verified it. It keeps the signed form, so the replica can be checked again later, and the ETag, so the next fetch asks only whether it changed. The request prints before it is sent. */
export const poolFetch = async (deps: RunDeps, options: { server?: string | undefined; harness?: string | undefined; harnessVersion: string }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, FETCH, options.server);
  const { harnessVersion } = options;
  if (!isBundleVersion(harnessVersion)) throw usage(`${harnessVersion} is not a public harness version.`, FETCH);
  const { token, signingKeys } = await signedIn(deps, storeDir, server, FETCH);
  const harness = await fetchHarness(deps, storeDir, options.harness);
  const file = replicaFile(storeDir, server, harness, harnessVersion);
  const kept = await keptReplica(file, signingKeys, harness, harnessVersion);
  const credential = new Masker();
  credential.add(token);
  const reply = await ask(deps, FETCH, server, `/bundle/${harness}/${encodeURIComponent(harnessVersion)}/${encodeURIComponent(VOCAB_VERSION)}`, { token, show: credential, ...(kept?.etag === undefined ? {} : { ifNoneMatch: kept.etag }) });
  const emit = emitOf(deps);
  if (reply.status === 429) {
    emit('fetch', { harness, fetches: 1, capHits: 1 });
    throw cappedError(deps, reply, kept !== undefined);
  }
  if (reply.status === 304) {
    // A 304 answers an If-None-Match, so one to a fetch that sent none is a pool that has lost track of what it was asked.
    if (kept?.etag === undefined) {
      emit('fetch', { harness, fetches: 1 });
      throw new CliError('The pool answered 304 to a fetch that named no kept bundle.', ExitCode.UNEXPECTED, FETCH);
    }
    const { cells, motifs, reads, asOf, floors } = kept.bundle;
    emit('fetch', { harness, fetches: 1, etagHits: 1, reads: reads.length });
    return {
      document: { ok: true, server, harness, harnessVersion, file, unchanged: true, cells: cells.length, motifs: motifs.length, reads: reads.length, asOf, ...(floors === undefined ? {} : { floors }) },
      text: `${harness} ${harnessVersion} is unchanged: the bundle at ${file} is still current (${String(reads.length)} reads, ${String(cells.length)} cells, and ${String(motifs.length)} motifs).${floorSentence(floors)}`,
    };
  }
  // A refused fetch and a bundle that fails verification both reached the pool, so each is a fetch; only the success adds reads.
  if (reply.status !== 200) {
    emit('fetch', { harness, fetches: 1 });
    throw refusal(FETCH, reply);
  }
  const verified = await verifyBundle(reply.body, signingKeys, harness, harnessVersion);
  if (!verified.ok) {
    const title = `Refused the bundle: ${verified.reason}.`;
    emit('fetch', { harness, fetches: 1 });
    throw new CliError(title, ExitCode.INVALID, FETCH, { code: 'bundle_unverified', title });
  }
  const etag = reply.headers.get('etag');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...(isObject(reply.body) ? reply.body : {}), ...(etag === null ? {} : { etag }) })}
`);
  const { cells, motifs, reads, asOf, floors } = verified.bundle;
  emit('fetch', { harness, fetches: 1, reads: reads.length });
  return {
    document: { ok: true, server, harness, harnessVersion, file, unchanged: false, cells: cells.length, motifs: motifs.length, reads: reads.length, asOf, ...(floors === undefined ? {} : { floors }) },
    text: `Fetched ${harness} ${harnessVersion}: ${String(reads.length)} reads, ${String(cells.length)} cells, and ${String(motifs.length)} motifs, verified against the pinned key and kept at ${file}.${floorSentence(floors)}`,
  };
};

const RAW = 'pool-raw';

/** The raw prompt, in plain words: shown by `oars pool raw` until it is answered, and what the detached sender relies on. Redaction is best effort and the text says so. */
export const RAW_PROMPT = [
  'Raw transcripts are separate from the covenant. If you say yes, then once the pool says your account accepted its covenant, the sender that a session-end hook or any oars command starts (at most about once an hour) uploads a redacted copy of each full transcript of every folder you allowed, beside its skeleton, except a folder you set to skeleton only or off.',
  'Redaction runs on this machine, before anything is queued, and it is best effort: it masks secret shapes it knows, emails, your username, home paths, environment values, and hosts, and it can miss a secret that has no recognizable shape or a name written in prose.',
  'It also does not catch a host with no dot, a public host name outside a link, quoted file contents and command output, a secret split across lines, images and attachments, a JSON env value, your username written another way, another person\'s hyphenated name in a project folder path, or an IPv6 address with a zone or inside a longer word, and a common-word account name is masked everywhere it appears.',
  'The blocks the harness adds on its own (instruction files, memory, skill lists, the system prompt) are replaced by a short marker, but a block in a shape the redactor does not list yet, a summary the harness writes for a session you left, a file it quotes after compaction, the echo of a command you ran, a reminder the harness puts in the middle of a message, and what an agent reports back are not, and stay as written; the project folder name and working directory on each line also stay readable, apart from the masking above.',
  'Say no, or say nothing, and only skeletons go to the pool. Change your mind any time: oars pool raw --consent yes|no. A no stops later sends only; it cannot recall what was already sent.',
].join('\n');

/** `oars pool raw`: shows the raw prompt and the answer so far; `--consent yes|no` records the answer; `--folder <entry> --mode all|skeleton|off` sets what one folder may send. */
export const poolRaw = async (deps: RunDeps, options: { consent?: string | undefined; folder?: string | undefined; mode?: string | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  if (options.consent !== undefined && options.consent !== 'yes' && options.consent !== 'no') throw usage('--consent takes yes or no.', RAW);
  if ((options.folder === undefined) !== (options.mode === undefined)) throw usage('--folder and --mode go together: --folder <folder or glob> --mode all|skeleton|off.', RAW);
  if (options.mode !== undefined && options.mode !== 'all' && options.mode !== 'skeleton' && options.mode !== 'off') throw usage('--mode takes all, skeleton, or off.', RAW);
  const { folder, mode } = options;
  const choices = await updatePoolChoices(runtime.storeDir, (current) => {
    if (options.consent !== undefined) current.rawConsent = options.consent === 'yes' ? 'granted' : 'declined';
    if (folder !== undefined) {
      if (mode === 'all') Reflect.deleteProperty(current.folders, folder);
      else if (mode === 'skeleton' || mode === 'off') current.folders[folder] = mode;
    }
  });
  const answer = choices.rawConsent === null ? 'not answered yet: only skeletons go to the pool' : choices.rawConsent === 'granted' ? 'yes: redacted raw copies leave' : 'no: only skeletons go to the pool';
  const switched = Object.entries(choices.folders).map(([entry, set]) => `  ${entry}: ${set === 'off' ? 'nothing sent to the pool' : 'skeletons only'}`);
  const lines = [...(choices.rawConsent === null ? [RAW_PROMPT, ''] : []), `Raw copies: ${answer}.`, ...(switched.length === 0 ? [] : ['Folders switched down:', ...switched])];
  return { document: { ok: true, rawConsent: choices.rawConsent, folders: choices.folders }, text: lines.join('\n') };
};

const COVERAGE = 'pool-coverage';

/** A named value from a closed list, or a usage error that lists the members. */
const oneOfList = <T extends string>(list: readonly T[], flag: string, value: string): T => {
  const found = list.find((entry) => entry === value);
  if (found === undefined) throw usage(`${flag} takes one of ${list.join(', ')}; got ${value}. Nothing was saved.`, COVERAGE);
  return found;
};

/**
 * `oars pool coverage`: the two bands only the operator can state, kept on this machine and read at deposit. They are what the pool can say about whom a deposit covers, not a filter; `unknown` states nothing.
 * With no flag it prints what is set.
 */
export const poolCoverage = async (deps: RunDeps, options: { orgSize?: string | undefined; repoVisibility?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const before = await readCoverageSetting(storeDir);
  const setting = {
    orgSize: options.orgSize === undefined ? before.orgSize : oneOfList(ORG_SIZES, '--org-size', options.orgSize),
    repoVisibility: options.repoVisibility === undefined ? before.repoVisibility : oneOfList(REPO_VISIBILITIES, '--repo-visibility', options.repoVisibility),
  };
  const changed = options.orgSize !== undefined || options.repoVisibility !== undefined;
  if (changed) await writeCoverageSetting(storeDir, setting);
  const lines = [`Organization size: ${setting.orgSize}`, `Repository visibility: ${setting.repoVisibility}`, 'Both stay on this machine until a deposit states them as bands; nothing is looked up. The team band is counted from each repository\'s local git log at deposit.'];
  return { document: { ok: true, saved: changed, ...setting }, text: lines.join('\n') };
};
