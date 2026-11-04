// `oars pool` (t758): the only part of the sessions code that talks to a remote. The server is always named, by flag or environment, so nothing leaves on a default. Sign-in is the
// pool's own device flow and reads no harness token; a session leaves only as a closed-vocabulary skeleton, and only after the V15 check found it clean. Local capture, recall,
// and reads never come through here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, exitCodeForProblem, ExitCode, unreachableError } from '../errors.js';
import { checkSession, exclusionPaths, type Reason } from './exclusion.js';
import { isBundleVersion, parseSkeleton, sessionsOf, skeletonOf, VOCAB_VERSION, verifyBundle, type Bundle, type PinnedKey } from './pool-wire.js';
import { Masker, printed, TRANSPORT_HEADERS, waitWords, type Outgoing } from './pool-print.js';
import { contentHash } from './read.js';
import { loadStore, type SessionsRuntime } from './store.js';

const LOGIN = 'pool-login';
const DEPOSIT = 'pool-deposit';
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

interface Reply {
  status: number;
  body: unknown;
  headers: Headers;
}

interface Call {
  body?: unknown;
  token?: string;
  /** The ETag of the bundle already kept, so the pool can answer 304 with no bundle. */
  ifNoneMatch?: string;
  /** Set for a command that prints what it sends: the print comes first, with these secrets masked. */
  show?: Masker;
}

/** One call to the pool. A redirect is an error: it could carry a skeleton or a token somewhere the checks on the named server never saw. */
const ask = async (deps: RunDeps, step: string, server: string, path: string, init: Call): Promise<Reply> => {
  const headers: Array<[string, string]> = [['user-agent', `oars/${deps.version}`], ['accept', 'application/json']];
  if (init.token !== undefined) headers.push(['authorization', `Bearer ${init.token}`]);
  if (init.ifNoneMatch !== undefined) headers.push(['if-none-match', init.ifNoneMatch]);
  if (init.body !== undefined) headers.push(['content-type', 'application/json']);
  headers.push(...TRANSPORT_HEADERS);
  const request: Outgoing = { method: init.body === undefined ? 'GET' : 'POST', url: new URL(path, server), headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) };
  return send(deps, step, request, init.show);
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
  // `openBrowser` parses the link before it returns its promise, so one that cannot parse has to stop here or it throws past the login's catch.
  if (!isObject(body) || deviceCode === undefined || userCode === undefined || verificationUri === undefined || !URL.canParse(verificationUri)) throw new CliError('The provider did not start a sign-in.', ExitCode.UNEXPECTED, LOGIN);
  return { deviceCode, userCode, verificationUri, intervalMs: (numberIn(body, 'interval') ?? DEFAULT_INTERVAL_SEC) * 1000, expiresMs: (numberIn(body, 'expires_in') ?? DEFAULT_EXPIRY_SEC) * 1000 };
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
 * `oars pool login` (spec Section 3): the device flow runs here, against the provider, and the pool sees only the provider's token, once, and answers its own credential. Every request prints before it is sent, with the device code, the provider's token,
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
  masker.add(signIn.token);
  const known = saved.find((entry) => entry.server === server);
  // The key is trusted once, here, and never replaced by a later login: a server that swaps it could otherwise sign anything it likes.
  if (known !== undefined && known.signingKey.x !== signIn.signingKey.x) throw new CliError(`${server} now signs with a different key than the one pinned at your first login. Nothing was saved. If the pool really did change its key, remove ${server} from ${signInsFile(storeDir)} and sign in again.`, ExitCode.AUTH, LOGIN, { code: 'signing_key_changed', title: 'The pool signing key changed.' });
  await mkdir(storeDir, { recursive: true });
  await writeFile(signInsFile(storeDir), `${JSON.stringify([...saved.filter((entry) => entry !== known), signIn])}\n`, { mode: 0o600 });
  return { document: { ok: true, server, account: signIn.account, expiresAt: signIn.expiresAt }, text: `Signed in to ${server} as ${signIn.account}.` };
};

/** Deposits stop here before a skeleton is built when the server is closed or wants a covenant accepted, so nothing crosses the wire for it to refuse. */
const openCovenant = async (deps: RunDeps, server: string, token: string, accept: string | undefined): Promise<void> => {
  const reply = await ask(deps, DEPOSIT, server, '/v1/covenant', { token });
  if (reply.status !== 200 || !isObject(reply.body)) throw refusal(DEPOSIT, reply);
  const version = textIn(reply.body, 'version');
  if (version === undefined) {
    const title = 'This pool is not taking deposits: its covenant is not published.';
    throw new CliError(title, ExitCode.AUTH, DEPOSIT, { code: 'deposits_closed', title, status: 403 });
  }
  if (accept !== undefined) {
    const accepted = await ask(deps, DEPOSIT, server, '/v1/covenant/accept', { token, body: { version: accept } });
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
  deposited: number;
  excluded: { term: number; noRaw: number; noTerms: number; unreadable: number };
  /** Captured before steps and frames, so it holds no closed reading to send. Re-capture would give it one. */
  uncaptured: number;
  /** Refused by the vocabulary, here or at the server; the count of those and which fields, never a value. */
  refused: number;
  refusedFields: string[];
  tooLarge: number;
}

const excludedKey = (reason: Exclude<Reason, 'clean'>): keyof DepositCounts['excluded'] => (reason === 'no-raw' ? 'noRaw' : reason === 'no-terms' ? 'noTerms' : reason);

/** `oars pool deposit`: every session in the store that passes the V15 check goes up as a skeleton. An excluded one is never built or sent, and only counts are printed. */
export const poolDeposit = async (deps: RunDeps, options: { server?: string | undefined; acceptCovenant?: string | undefined }): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const server = poolServer(deps.env, DEPOSIT, options.server);
  const { account, token } = await signedIn(deps, runtime.storeDir, server, DEPOSIT);
  await openCovenant(deps, server, token, options.acceptCovenant);
  const { terms } = exclusionPaths(runtime.projectsRoot, deps.env);
  const counts: DepositCounts = { sessions: 0, deposited: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, uncaptured: 0, refused: 0, refusedFields: [], tooLarge: 0 };
  const refusedFields = new Set<string>();
  for (const records of sessionsOf(await loadStore(runtime.storeDir))) {
    counts.sessions += 1;
    const verdict = await checkSession(runtime, terms, records.main.project, records.main.session);
    if (verdict.reason !== 'clean') {
      counts.excluded[excludedKey(verdict.reason)] += 1;
      continue;
    }
    // Hashed with the account, so a redeposit replaces its own row and two accounts' copies of one session cannot be joined.
    const skeleton = skeletonOf(records, contentHash([account, records.main.session]));
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
    const reply = await ask(deps, DEPOSIT, server, '/v1/deposits', { token, body: parsed.skeleton });
    if (reply.status === 201) {
      counts.deposited += 1;
    } else if (reply.status === 413) {
      counts.tooLarge += 1;
    } else if (reply.status === 422) {
      counts.refused += 1;
      const field = isObject(reply.body) ? textIn(reply.body, 'field') : undefined;
      if (field !== undefined) refusedFields.add(field);
    } else {
      throw refusal(DEPOSIT, reply);
    }
  }
  counts.refusedFields = [...refusedFields].sort();
  const { term, noRaw, noTerms, unreadable } = counts.excluded;
  const lines = [
    `Deposited ${String(counts.deposited)} of ${String(counts.sessions)} sessions to ${server}.`,
    `Excluded by the V15 check, never sent: ${String(term)} for a term, ${String(noRaw)} with no raw to scan, ${String(noTerms)} with no term file, ${String(unreadable)} unreadable.`,
    `Not sent: ${String(counts.uncaptured)} captured before steps and frames, ${String(counts.tooLarge)} too large, ${String(counts.refused)} refused by the vocabulary${counts.refusedFields.length === 0 ? '' : ` (${counts.refusedFields.join(', ')})`}.`,
  ];
  return { document: { ok: true, server, ...counts }, text: lines.join('\n') };
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
  const title = `The pool's weekly fetch cap is used up. ${when} ${kept ? 'The bundle already on disk is untouched, and recall keeps reading it.' : 'No bundle is kept yet.'}`;
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
