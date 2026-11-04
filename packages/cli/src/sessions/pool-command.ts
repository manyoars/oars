// `oars pool`: the only part of the sessions code that talks to a remote. The server is always named, by flag or environment, so nothing leaves on a default. Sign-in runs the provider's device flow here and reads no harness token; a session leaves only as a closed-vocabulary skeleton, and only after the V15 check found it clean. Local capture, recall,
// and reads never come through here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, exitCodeForProblem, ExitCode, unreachableError } from '../errors.js';
import { compileAllow } from './allow.js';
import { checkSession, exclusionPaths, type Reason } from './exclusion.js';
import { discardStale, FIELD_ROWS, fieldsOf, heldBatches, lockedBatch, markShown, outboxFolder, removeBatchesExcept, staleBatches, unchangedBytes, writeBatch, type LockRefusal } from './pool-outbox.js';
import { isBundleVersion, parseSkeleton, sessionsOf, skeletonOf, VOCAB_VERSION, verifyBundle, type Bundle, type PinnedKey } from './pool-wire.js';
import { Masker, printed, TRANSPORT_HEADERS, waitWords, type Outgoing } from './pool-print.js';
import { shellReader } from './projection.js';
import { isVocabularyExpired, REGISTRY_MAX_AGE_DAYS, VOCAB_SNAPSHOT_DATE } from './public-vocabulary.js';
import { contentHash } from './read.js';
import { loadStore, readSaved, type SessionsRuntime } from './store.js';
import { vocabulary } from './vocab-load.js';

const LOGIN = 'pool-login';
const DEPOSIT = 'pool-deposit';
const OUTBOX = 'pool-outbox';
const POOL_DEPOSITS = '/v1/deposits';
const FETCH = 'pool-fetch';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const POOL_PROVIDERS = ['github', 'google'] as const;
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_EXPIRY_SEC = 900;
/** RFC 8628: a `slow_down` adds five seconds to every poll after it. */
const SLOW_DOWN_MS = 5000;

const usage = (message: string, step: string): CliError => new CliError(message, ExitCode.USAGE, step);

/** `--server`, else `OARS_POOL_URL`; never a default. A token and a session's shape cross this connection, so plain http goes only to this machine. */
export const poolServer = (env: NodeJS.ProcessEnv, step: string, named?: string): string => {
  const given = named ?? env.OARS_POOL_URL;
  if (given === undefined || given === '') throw usage('Name the pool server with --server or OARS_POOL_URL; there is no default.', step);
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

const runtimeOf = (deps: RunDeps): SessionsRuntime => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  return deps.sessions;
};

const textIn = (value: object, key: string): string | undefined => {
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'string' && found !== '' ? found : undefined;
};

const numberIn = (value: object, key: string): number | undefined => {
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
};

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const keyOf = (value: unknown): PinnedKey | undefined => {
  if (!isObject(value)) return undefined;
  const [kty, crv, x] = [textIn(value, 'kty'), textIn(value, 'crv'), textIn(value, 'x')];
  return kty === 'OKP' && crv === 'Ed25519' && x !== undefined ? { kty, crv, x } : undefined;
};

/** One server's sign-in, as `login` saved it. */
interface SignIn {
  server: string;
  account: string;
  token: string;
  expiresAt: number;
  /** Pinned at the first login to this server; every bundle is checked against it. */
  signingKey: PinnedKey;
}

const signInOf = (value: unknown): SignIn | undefined => {
  if (!isObject(value)) return undefined;
  const [server, account, token, expiresAt] = [textIn(value, 'server'), textIn(value, 'account'), textIn(value, 'token'), numberIn(value, 'expiresAt')];
  const signingKey = keyOf(Reflect.get(value, 'signingKey'));
  return server === undefined || account === undefined || token === undefined || expiresAt === undefined || signingKey === undefined ? undefined : { server, account, token, expiresAt, signingKey };
};

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const signInsFile = (storeDir: string): string => join(storeDir, 'pool-accounts.json');

/** Every saved sign-in. A file that cannot be read stops the command: treating it as empty would forget a pin and trust whatever key the server names next. */
const loadSignIns = async (storeDir: string, step: string): Promise<SignIn[]> => {
  const file = signInsFile(storeDir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const damaged = new CliError(`${file} cannot be read. Remove it, then run oars pool login again.`, ExitCode.INVALID, step);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw damaged;
  }
  if (!Array.isArray(parsed)) throw damaged;
  const entries: readonly unknown[] = parsed;
  return entries.map((entry) => {
    const signIn = signInOf(entry);
    if (signIn === undefined) throw damaged;
    return signIn;
  });
};

const signedIn = async (deps: RunDeps, storeDir: string, server: string, step: string): Promise<SignIn> => {
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
  /** The ETag of the bundle already kept, so the pool can answer 304 with no bundle. */
  ifNoneMatch?: string;
  /** Set for a command that prints what it sends: the print comes first, with these secrets masked. */
  show?: Masker;
}

/** How a request leaves this machine. The command line passes none and so sends no batch; the lock in `deposit --send` is tested with one. */
export type Sender = (request: Outgoing) => Promise<Reply>;

/** The request exactly as it will be sent: `outbox` prints it, and `ask` hands the same value to `fetch`. */
const outgoing = (deps: RunDeps, server: string, path: string, init: Call): Outgoing => {
  const headers: Array<[string, string]> = [['user-agent', `oars/${deps.version}`], ['accept', 'application/json']];
  if (init.token !== undefined) headers.push(['authorization', `Bearer ${init.token}`]);
  // Node's `fetch` writes `cache-control` and `pragma` itself whenever `if-none-match` is set, so they are named here to be printed.
  if (init.ifNoneMatch !== undefined) headers.push(['if-none-match', init.ifNoneMatch], ['cache-control', 'no-cache'], ['pragma', 'no-cache']);
  const body = init.bytes ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers.push(['content-type', 'application/json']);
  headers.push(...TRANSPORT_HEADERS);
  return { method: body === undefined ? 'GET' : 'POST', url: new URL(path, server), headers, ...(body === undefined ? {} : { body }) };
};

/** One call to the pool. A redirect is an error: it could carry a batch or a token somewhere the checks on the named server never saw. */
const ask = (deps: RunDeps, step: string, server: string, path: string, init: Call, via?: Sender): Promise<Reply> => {
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
    throw unreachableError(step, error);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body, headers: response.headers };
};

/** The sender a real send would use: the request goes out over the network as built. The command line does not pass it (sending waits on the covenant); the loopback test does, to read what reaches the socket. */
export const networkSender = (deps: RunDeps, step: string): Sender => (request) => send(deps, step, request, undefined);

/** The server's named refusal, as a failure: its `error` is the problem's code in `--json`. */
const refusal = (step: string, { status, body }: Reply): CliError => {
  const code = isObject(body) ? textIn(body, 'error') : undefined;
  const message = (isObject(body) ? textIn(body, 'message') : undefined) ?? `The pool answered HTTP ${String(status)}.`;
  return new CliError(message, exitCodeForProblem(status, code === undefined ? undefined : { code }), step, { title: message, status, ...(code === undefined ? {} : { code }) });
};

/** What the client needs to run one provider's device flow itself. The client ID and Google's `client_secret` come from the environment, since the OAuth apps are the operator's to create. */
interface Provider {
  deviceUrl: string;
  tokenUrl: string;
  /** The least that names the account: Google's `openid` gives only `sub`, and GitHub's public profile needs no scope. */
  scope: string;
  clientIdVar: 'OARS_GITHUB_CLIENT_ID' | 'OARS_GOOGLE_CLIENT_ID';
  /** Google's device flow requires its client secret at the token route, which is not secret for an installed app; GitHub's takes none. */
  secretVar?: 'OARS_GOOGLE_CLIENT_SECRET';
}

const PROVIDER_FLOWS = new Map<string, Provider>([
  ['github', { deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token', scope: '', clientIdVar: 'OARS_GITHUB_CLIENT_ID' }],
  ['google', { deviceUrl: 'https://oauth2.googleapis.com/device/code', tokenUrl: 'https://oauth2.googleapis.com/token', scope: 'openid', clientIdVar: 'OARS_GOOGLE_CLIENT_ID', secretVar: 'OARS_GOOGLE_CLIENT_SECRET' }],
]);

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface ProviderConfig {
  clientId: string;
  clientSecret: string | undefined;
}

/** The provider's side of the flow, read from the environment. An unset value stops the command before anything is sent, and names what is missing. */
const configOf = (env: NodeJS.ProcessEnv, provider: Provider): ProviderConfig => {
  const set = (name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  const clientId = set(provider.clientIdVar);
  if (clientId === undefined) throw usage(`Set ${provider.clientIdVar} to the client ID of the Many Oars OAuth app; it is not set.`, LOGIN);
  const clientSecret = provider.secretVar === undefined ? undefined : set(provider.secretVar);
  if (provider.secretVar !== undefined && clientSecret === undefined) throw usage(`Set ${provider.secretVar} to the client secret of the Many Oars OAuth app; it is not set.`, LOGIN);
  return { clientId, clientSecret };
};

/** One form POST to a provider, printed before it is sent. The provider answers JSON on whatever status it chooses (Google's pending poll is a 428), so the caller reads the body and not the status. */
const askProvider = (deps: RunDeps, url: string, form: Array<[string, string]>, masker: Masker): Promise<Reply> => {
  const headers: Array<[string, string]> = [['user-agent', `oars/${deps.version}`], ['accept', 'application/json'], ['content-type', 'application/x-www-form-urlencoded'], ...TRANSPORT_HEADERS];
  return send(deps, LOGIN, { method: 'POST', url: new URL(url), headers, body: new URLSearchParams(form).toString() }, masker);
};

interface Device {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresMs: number;
}

const deviceOf = ({ body }: Reply): Device => {
  // Google names the link `verification_url`, against the RFC's `verification_uri`.
  const [deviceCode, userCode, verificationUri] = isObject(body) ? [textIn(body, 'device_code'), textIn(body, 'user_code'), textIn(body, 'verification_uri') ?? textIn(body, 'verification_url')] : [];
  // A provider that refuses here (GitHub's `device_flow_disabled`, Google's `invalid_client`) is how an unfinished OAuth app shows, so its word goes to the operator.
  const refusal = isObject(body) ? textIn(body, 'error') : undefined;
  if (refusal !== undefined) {
    const title = `The provider refused the sign-in: ${refusal}.`;
    throw new CliError(title, ExitCode.AUTH, LOGIN, { code: 'login_refused', title });
  }
  // `openBrowser` parses the link before it returns its promise, so one that cannot parse has to stop here or it throws past the login's catch.
  if (!isObject(body) || deviceCode === undefined || userCode === undefined || verificationUri === undefined || !URL.canParse(verificationUri)) throw new CliError('The provider did not start a sign-in.', ExitCode.UNEXPECTED, LOGIN);
  // An interval of 0 or below would poll with no wait and never run out the clock, so it takes the default like a missing one.
  const interval = numberIn(body, 'interval');
  return { deviceCode, userCode, verificationUri, intervalMs: (interval === undefined || interval <= 0 ? DEFAULT_INTERVAL_SEC : interval) * 1000, expiresMs: (numberIn(body, 'expires_in') ?? DEFAULT_EXPIRY_SEC) * 1000 };
};

/** Polls the provider's token route until the operator approves, and returns the provider's token. Time is counted in the waits asked for, so a machine that slept through the code still gets one poll that says it expired. */
const awaitToken = async (deps: RunDeps, provider: Provider, config: ProviderConfig, device: Device, masker: Masker): Promise<string> => {
  let { intervalMs } = device;
  const form: Array<[string, string]> = [['client_id', config.clientId], ['device_code', device.deviceCode], ['grant_type', DEVICE_GRANT]];
  if (config.clientSecret !== undefined) form.push(['client_secret', config.clientSecret]);
  for (let waited = 0; waited < device.expiresMs; waited += intervalMs) {
    await deps.sleep(intervalMs);
    const { body } = await askProvider(deps, provider.tokenUrl, form, masker);
    if (!isObject(body)) throw new CliError('The provider answered a sign-in poll with no body.', ExitCode.UNEXPECTED, LOGIN);
    const accessToken = textIn(body, 'access_token');
    if (accessToken !== undefined) return accessToken;
    const error = textIn(body, 'error') ?? 'no_token';
    if (error === 'slow_down') intervalMs += SLOW_DOWN_MS;
    else if (error === 'expired_token') break;
    else if (error !== 'authorization_pending') {
      const title = `The provider refused the sign-in: ${error}.`;
      throw new CliError(title, ExitCode.AUTH, LOGIN, { code: 'login_refused', title });
    }
  }
  const title = 'The sign-in code expired. Run oars pool login again.';
  throw new CliError(title, ExitCode.AUTH, LOGIN, { code: 'EXPIRED_TOKEN', title });
};

/**
 * `oars pool login` (spec Section 1.4): the device flow runs here, against the provider, and the pool sees only the provider's token, once, and answers its own credential. Every request prints before it is sent, with the device code, the provider's token,
 * and the credential masked as `<credential: n bytes>`. A client ID, scope, grant type, and Google's `client_secret` print as they are: none is secret.
 */
export const poolLogin = async (deps: RunDeps, options: { server?: string | undefined; provider?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, LOGIN, options.server);
  const { provider } = options;
  const flow = PROVIDER_FLOWS.get(provider ?? '');
  if (provider === undefined || flow === undefined) throw usage(`The provider is one of ${POOL_PROVIDERS.join(', ')}.`, LOGIN);
  const config = configOf(deps.env, flow);
  const saved = await loadSignIns(storeDir, LOGIN);
  const masker = new Masker();
  const device = deviceOf(await askProvider(deps, flow.deviceUrl, [['client_id', config.clientId], ['scope', flow.scope]], masker));
  masker.add(device.deviceCode);
  deps.io.stderr(`To sign in, open ${device.verificationUri}\nand confirm the code ${device.userCode}\n`);
  await deps.openBrowser(device.verificationUri).catch(() => {
    deps.io.stderr('Could not open a browser; open the link above yourself.\n');
  });
  const accessToken = await awaitToken(deps, flow, config, device, masker);
  masker.add(accessToken);
  const reply = await ask(deps, LOGIN, server, '/v1/login', { body: { provider, token: accessToken }, show: masker });
  if (reply.status !== 200) throw refusal(LOGIN, reply);
  const signIn = signInOf(isObject(reply.body) ? { ...reply.body, server } : undefined);
  if (signIn === undefined) throw new CliError('The pool answered a sign-in with no account, token, or signing key.', ExitCode.UNEXPECTED, LOGIN);
  const known = saved.find((entry) => entry.server === server);
  // The key is trusted once, here, and never replaced by a later login: a server that swaps it could otherwise sign anything it likes.
  if (known !== undefined && known.signingKey.x !== signIn.signingKey.x) throw new CliError(`${server} now signs with a different key than the one pinned at your first login. Nothing was saved. If the pool really did change its key, remove ${server} from ${signInsFile(storeDir)} and sign in again.`, ExitCode.AUTH, LOGIN, { code: 'signing_key_changed', title: 'The pool signing key changed.' });
  await mkdir(storeDir, { recursive: true });
  await writeFile(signInsFile(storeDir), `${JSON.stringify([...saved.filter((entry) => entry !== known), signIn])}\n`, { mode: 0o600 });
  return { document: { ok: true, server, account: signIn.account, expiresAt: signIn.expiresAt }, text: `Signed in to ${server} as ${signIn.account}.` };
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
    throw new CliError(title, ExitCode.AUTH, DEPOSIT, { code: 'covenant_not_accepted', title, status: 403 });
  }
};

interface DepositCounts {
  sessions: number;
  /** Batches written to the outbox. Nothing has been sent. */
  batched: number;
  /** Sessions kept out by a session gate, by reason and by count only: never a folder name or a term. */
  excluded: { folder: number; term: number; noRaw: number; noTerms: number; unreadable: number };
  /** Captured before steps and frames, so it holds no closed reading to build. Re-capture would give it one. */
  uncaptured: number;
  /** Refused by the vocabulary here; the count of those and which fields, never a value. */
  refused: number;
  refusedFields: string[];
  /** Batches built under an older vocabulary or field list, removed from the outbox. */
  discarded: number;
  /** Batches of an earlier pass whose session no longer passes (a gate, the allowlist, a refusal) or is gone from the store, removed so the outbox holds only what this pass built. */
  withdrawn: number;
}

const excludedKey = (reason: Exclude<Reason, 'clean'>): keyof DepositCounts['excluded'] => (reason === 'no-raw' ? 'noRaw' : reason === 'no-terms' ? 'noTerms' : reason);

/** A deposit answered with this code is sent again: another deposit of the same session landed between the pool's read and its write, and the next one nets against the winner. */
const DEPOSIT_CONFLICT = 'deposit_conflict';
const SEND_ATTEMPTS = 3;

const vocabularyExpired = (deps: RunDeps): CliError | undefined => {
  if (!isVocabularyExpired(new Date(deps.now()))) return undefined;
  const title = `This oars is out of date: its vocabulary ${VOCAB_VERSION} was taken on ${VOCAB_SNAPSHOT_DATE}, over ${String(REGISTRY_MAX_AGE_DAYS)} days ago. Upgrade with npm install -g @manyoars/oars, then run oars pool deposit again. Your sessions stay on this machine.`;
  return new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code: 'vocabulary_expired', title, status: 409 });
};

const lockMessages: { [code in LockRefusal]: string } = {
  batch_unknown: 'No batch with that hash is in the outbox. Run oars pool outbox to list them.',
  batch_not_shown: 'That batch was never printed. Run oars pool outbox, read it, then send it.',
  batch_changed: 'That batch changed on disk after it was printed, or since it was written, so it was not sent. Run oars pool deposit to build it again, then oars pool outbox to print it.',
};

/** `deposit --send <hash>`: the lock, then (only when a sender is given) the covenant and the request. The body is read and hashed again just before the request. */
const sendBatch = async (deps: RunDeps, options: { outbox: string; server: string; token: string; hash: string; acceptCovenant: string | undefined; via: Sender | undefined }): Promise<Outcome> => {
  const { outbox, server, token, hash, via } = options;
  if (!/^[0-9a-f]{64}$/.test(hash)) throw usage('--send takes the SHA-256 that oars pool outbox printed: 64 hexadecimal characters.', DEPOSIT);
  const locked = await lockedBatch(outbox, hash);
  if (!locked.ok) {
    const title = lockMessages[locked.code];
    throw new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code: locked.code, title, status: 409 });
  }
  if (via === undefined) {
    const title = 'Sending a batch waits on the pool covenant: this oars does not send one yet. Nothing was sent.';
    throw new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code: 'sending_disabled', title, status: 409 });
  }
  await openCovenant(deps, server, token, options.acceptCovenant, via);
  const bytes = await unchangedBytes(locked.file, hash);
  if (bytes === undefined) {
    const title = lockMessages.batch_changed;
    throw new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code: 'batch_changed', title, status: 409 });
  }
  let reply = await ask(deps, DEPOSIT, server, POOL_DEPOSITS, { token, bytes }, via);
  for (let attempt = 1; attempt < SEND_ATTEMPTS && reply.status === 409 && isObject(reply.body) && textIn(reply.body, 'error') === DEPOSIT_CONFLICT; attempt += 1) {
    reply = await ask(deps, DEPOSIT, server, POOL_DEPOSITS, { token, bytes }, via);
  }
  if (reply.status !== 201) throw refusal(DEPOSIT, reply);
  return { document: { ok: true, server, hash, sent: true }, text: `Sent batch ${hash} to ${server}.` };
};

/**
 * `oars pool deposit`: every session in the store that passes both session gates is built into a canonical batch in the outbox, and the command stops: nothing is sent. The gates run before any projection does: the folder
 * allowlist, then the V15 check. A session that fails either, or has no raw to scan, is counted and never built. `--send <hash>` is the lock in `sendBatch`.
 */
export const poolDeposit = async (deps: RunDeps, options: { server?: string | undefined; acceptCovenant?: string | undefined; send?: string | undefined; via?: Sender | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const server = poolServer(deps.env, DEPOSIT, options.server);
  const { account, token } = await signedIn(deps, runtime.storeDir, server, DEPOSIT);
  // A client past `registry_max_age` builds no batch (spec Section 1.3): its sessions wait in `A` and nothing is lost. This comes before anything is written or sent.
  const expired = vocabularyExpired(deps);
  if (expired !== undefined) throw expired;
  // Accepting the covenant is a step of sending, which is disabled in this release: say so rather than exit 0 as though it was accepted.
  if (options.send === undefined && options.acceptCovenant !== undefined) throw usage('--accept-covenant belongs to --send, and sending is disabled in this release. Nothing was accepted.', DEPOSIT);
  const outbox = outboxFolder(runtime.storeDir, server);
  if (options.send !== undefined) return sendBatch(deps, { outbox, server, token, hash: options.send, acceptCovenant: options.acceptCovenant, via: options.via });
  const { terms } = exclusionPaths(runtime.projectsRoot, deps.env);
  const allow = compileAllow((await readSaved(runtime.storeDir)).allow);
  const discarded = await discardStale(outbox);
  const counts: DepositCounts = { sessions: 0, batched: 0, excluded: { folder: 0, term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, uncaptured: 0, refused: 0, refusedFields: [], discarded, withdrawn: 0 };
  const built = new Set<string>();
  const refusedFields = new Set<string>();
  for (const records of sessionsOf(await loadStore(runtime.storeDir))) {
    counts.sessions += 1;
    if (!allow.allows(records.main.project)) {
      counts.excluded.folder += 1;
      continue;
    }
    const verdict = await checkSession(runtime, terms, records.main.project, records.main.session);
    if (verdict.reason !== 'clean') {
      counts.excluded[excludedKey(verdict.reason)] += 1;
      continue;
    }
    // Hashed with the account, so a redeposit replaces its own batch and two accounts' copies of one session cannot be joined.
    const key = contentHash([account, records.main.session]);
    const skeleton = skeletonOf(records, key, shellReader(vocabulary()));
    if (skeleton === null) {
      counts.uncaptured += 1;
      continue;
    }
    const parsed = parseSkeleton(skeleton);
    if (!parsed.ok) {
      counts.refused += 1;
      refusedFields.add(parsed.field);
      continue;
    }
    await writeBatch(outbox, key, parsed.skeleton);
    built.add(key);
    counts.batched += 1;
  }
  // A session that fails a gate never enters the outbox, so a batch of it from an earlier pass goes too, and so does a batch of a session or account this store no longer holds.
  counts.withdrawn = await removeBatchesExcept(outbox, built);
  counts.refusedFields = [...refusedFields].sort();
  const { folder, term, noRaw, noTerms, unreadable } = counts.excluded;
  const lines = [
    `Wrote ${String(counts.batched)} of ${String(counts.sessions)} sessions to the outbox for ${server}. Nothing was sent.`,
    `Kept out by the session gates, never built: ${String(folder)} in a folder not on the allowlist, ${String(term)} for a term, ${String(noRaw)} with no raw to scan, ${String(noTerms)} with no term file, ${String(unreadable)} unreadable.`,
    `Not built: ${String(counts.uncaptured)} captured before steps and frames, ${String(counts.refused)} refused by the vocabulary${counts.refusedFields.length === 0 ? '' : ` (${counts.refusedFields.join(', ')})`}.`,
    ...(counts.withdrawn === 0 ? [] : [`Removed ${String(counts.withdrawn)} ${counts.withdrawn === 1 ? 'batch' : 'batches'} of sessions that no longer pass the gates or are no longer in the store.`]),
    ...(discarded === 0 ? [] : [`Discarded ${String(discarded)} ${discarded === 1 ? 'batch' : 'batches'} built under an older vocabulary or field list.`]),
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

/** `oars pool outbox`: prints each batch as it would be sent, the request line and every header included, with the bearer credential as its size and nothing else masked, then its SHA-256, and records that it was shown. `--explain` adds each field's rule. */
export const poolOutbox = async (deps: RunDeps, options: { server?: string | undefined; explain?: boolean | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const server = poolServer(deps.env, OUTBOX, options.server);
  const { token } = await signedIn(deps, runtime.storeDir, server, OUTBOX);
  const outbox = outboxFolder(runtime.storeDir, server);
  const { batches, edited } = await heldBatches(outbox);
  const masker = new Masker();
  masker.add(token);
  const shown: Array<{ hash: string; request: string; fields?: { [field: string]: string } }> = [];
  for (const batch of batches) {
    const fields = options.explain === true ? explained(batch.bytes) : undefined;
    shown.push({ hash: batch.hash, request: printed(outgoing(deps, server, POOL_DEPOSITS, { token, bytes: batch.bytes }), masker), ...(fields === undefined ? {} : { fields }) });
  }
  for (const { hash } of shown) await markShown(outbox, hash, deps.now());
  const stale = await staleBatches(outbox);
  const blocks = shown.map(({ hash, request, fields }) => [request, `sha256: ${hash}`, ...Object.entries(fields ?? {}).map(([field, row]) => `  ${field}: ${row}`)].join('\n'));
  const notes = [
    ...(edited === 0 ? [] : [`${String(edited)} ${edited === 1 ? 'batch was' : 'batches were'} edited on disk since ${edited === 1 ? 'it was' : 'they were'} written and ${edited === 1 ? 'is' : 'are'} not printed or sent. Run oars pool deposit to build ${edited === 1 ? 'it' : 'them'} again.`]),
    ...(stale === 0 ? [] : [`${String(stale)} ${stale === 1 ? 'batch was' : 'batches were'} built under an older vocabulary, field list, or skeleton format and will never be sent.`]),
  ];
  const text = shown.length === 0 ? ['The outbox is empty. Run oars pool deposit first.', ...notes].join('\n') : [...blocks, ...notes].join('\n\n');
  return { document: { ok: true, server, batches: shown, edited, stale }, text };
};

const replicaFile = (storeDir: string, server: string, harnessVersion: string): string => join(storeDir, 'pool-replica', contentHash(server), `${encodeURIComponent(harnessVersion)}.json`);

/** What an earlier fetch kept: the bundle, checked again against the pinned key, and the ETag the pool sent with it. Nothing readable and verified is nothing kept, and the next fetch is then an ordinary one. */
const keptReplica = async (file: string, key: PinnedKey, harnessVersion: string): Promise<{ etag: string | undefined; bundle: Bundle } | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  const verified = await verifyBundle(parsed, key, harnessVersion);
  return verified.ok ? { etag: isObject(parsed) ? textIn(parsed, 'etag') : undefined, bundle: verified.bundle } : undefined;
};

/** The weekly cap, as a failure of its own code: the bundle on disk is untouched, and the words say when the pool will answer again. */
const cappedError = (deps: RunDeps, reply: Reply, kept: boolean): CliError => {
  const retryAfter = reply.headers.get('retry-after');
  const wait = retryAfter === null ? undefined : waitWords(retryAfter, deps.now());
  const when = wait === undefined ? 'The pool did not say when; it counts fetches per ISO week, so try again next week.' : `Try again ${wait}.`;
  const title = `The pool's weekly fetch cap is used up. ${when} ${kept ? 'The bundle already on disk is untouched.' : 'No verified bundle is kept.'}`;
  return new CliError(title, ExitCode.CAPPED, FETCH, { code: 'fetch_cap', title, status: 429 }, undefined, { retryAfter });
};

/** `oars pool fetch`: one harness version's signed bundle, kept only once the key pinned at login has verified it. It keeps the signed form, so the replica can be checked again later, and the ETag, so the next fetch asks only whether it changed. The request prints before it is sent. */
export const poolFetch = async (deps: RunDeps, options: { server?: string | undefined; harnessVersion: string }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, FETCH, options.server);
  const { harnessVersion } = options;
  if (!isBundleVersion(harnessVersion)) throw usage(`${harnessVersion} is not a public harness version.`, FETCH);
  const { token, signingKey } = await signedIn(deps, storeDir, server, FETCH);
  const file = replicaFile(storeDir, server, harnessVersion);
  const kept = await keptReplica(file, signingKey, harnessVersion);
  const credential = new Masker();
  credential.add(token);
  const reply = await ask(deps, FETCH, server, `/bundle/${encodeURIComponent(harnessVersion)}/${encodeURIComponent(VOCAB_VERSION)}`, { token, show: credential, ...(kept?.etag === undefined ? {} : { ifNoneMatch: kept.etag }) });
  if (reply.status === 429) throw cappedError(deps, reply, kept !== undefined);
  if (reply.status === 304) {
    // A 304 answers an If-None-Match, so one to a fetch that sent none is a pool that has lost track of what it was asked.
    if (kept?.etag === undefined) throw new CliError('The pool answered 304 to a fetch that named no kept bundle.', ExitCode.UNEXPECTED, FETCH);
    const { cells, motifs, reads, asOf } = kept.bundle;
    return {
      document: { ok: true, server, harnessVersion, file, unchanged: true, cells: cells.length, motifs: motifs.length, reads: reads.length, asOf },
      text: `${harnessVersion} is unchanged: the bundle at ${file} is still current (${String(reads.length)} reads, ${String(cells.length)} cells, and ${String(motifs.length)} motifs).`,
    };
  }
  if (reply.status !== 200) throw refusal(FETCH, reply);
  const verified = await verifyBundle(reply.body, signingKey, harnessVersion);
  if (!verified.ok) {
    const title = `Refused the bundle: ${verified.reason}.`;
    throw new CliError(title, ExitCode.INVALID, FETCH, { code: 'bundle_unverified', title });
  }
  const etag = reply.headers.get('etag');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...(isObject(reply.body) ? reply.body : {}), ...(etag === null ? {} : { etag }) })}
`);
  const { cells, motifs, reads, asOf } = verified.bundle;
  return {
    document: { ok: true, server, harnessVersion, file, unchanged: false, cells: cells.length, motifs: motifs.length, reads: reads.length, asOf },
    text: `Fetched ${harnessVersion}: ${String(reads.length)} reads, ${String(cells.length)} cells, and ${String(motifs.length)} motifs, verified against the pinned key and kept at ${file}.`,
  };
};
