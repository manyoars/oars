// `oars pool` (t758): the only part of the sessions code that talks to a remote. The server is always named, by flag or environment, so nothing leaves on a default. Sign-in is the
// pool's own device flow and reads no harness token; a session leaves only as a closed-vocabulary skeleton, and only after the V15 check found it clean. Local capture, recall,
// and reads never come through here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, exitCodeForProblem, ExitCode, unreachableError } from '../errors.js';
import { checkSession, exclusionPaths, type Reason } from './exclusion.js';
import { isStack, parseSkeleton, sessionsOf, skeletonOf, verifySlice, type PinnedKey } from './pool-wire.js';
import { isVocabularyExpired, REGISTRY_MAX_AGE_DAYS, VOCAB_SNAPSHOT_DATE, VOCAB_VERSION } from './public-vocabulary.js';
import { contentHash } from './read.js';
import { loadStore, type SessionsRuntime } from './store.js';

const LOGIN = 'pool-login';
const DEPOSIT = 'pool-deposit';
const PULL = 'pool-pull';
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
  /** Pinned at the first login to this server; every slice is checked against it. */
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
}

/** One call to the pool. A redirect is an error: it could carry a skeleton or a token somewhere the checks on the named server never saw. */
const ask = async (deps: RunDeps, step: string, server: string, path: string, init: { body?: unknown; token?: string }): Promise<Reply> => {
  const headers = { 'user-agent': `oars/${deps.version}`, ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }) };
  let response: Response;
  try {
    response = await fetch(new URL(path, server), init.body === undefined ? { headers, redirect: 'error' } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(init.body), redirect: 'error' });
  } catch (error) {
    throw unreachableError(step, error);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

/** The server's named refusal, as a failure: its `error` is the problem's code in `--json`. */
const refusal = (step: string, { status, body }: Reply): CliError => {
  const code = isObject(body) ? textIn(body, 'error') : undefined;
  const message = (isObject(body) ? textIn(body, 'message') : undefined) ?? `The pool answered HTTP ${String(status)}.`;
  return new CliError(message, exitCodeForProblem(status, code === undefined ? undefined : { code }), step, { title: message, status, ...(code === undefined ? {} : { code }) });
};

interface Device {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresMs: number;
}

const deviceOf = (reply: Reply): Device => {
  if (reply.status !== 200) throw refusal(LOGIN, reply);
  const { body } = reply;
  const [deviceCode, userCode, verificationUri] = isObject(body) ? [textIn(body, 'deviceCode'), textIn(body, 'userCode'), textIn(body, 'verificationUri')] : [];
  // `openBrowser` parses the link before it returns its promise, so one that cannot parse has to stop here or it throws past the login's catch.
  if (!isObject(body) || deviceCode === undefined || userCode === undefined || verificationUri === undefined || !URL.canParse(verificationUri)) throw new CliError('The pool did not start a sign-in.', ExitCode.UNEXPECTED, LOGIN);
  return { deviceCode, userCode, verificationUri, intervalMs: (numberIn(body, 'interval') ?? DEFAULT_INTERVAL_SEC) * 1000, expiresMs: (numberIn(body, 'expiresIn') ?? DEFAULT_EXPIRY_SEC) * 1000 };
};

/** Polls until the provider approves. Time is counted in the waits it asked for, so a machine that slept through the code still gets one poll that says it expired. */
const awaitSignIn = async (deps: RunDeps, server: string, provider: string, device: Device): Promise<SignIn> => {
  let { intervalMs } = device;
  for (let waited = 0; waited < device.expiresMs; waited += intervalMs) {
    await deps.sleep(intervalMs);
    const reply = await ask(deps, LOGIN, server, '/v1/login/poll', { body: { provider, deviceCode: device.deviceCode } });
    if (reply.status !== 200) throw refusal(LOGIN, reply);
    const { body } = reply;
    if (!isObject(body)) throw new CliError('The pool answered a sign-in poll with no body.', ExitCode.UNEXPECTED, LOGIN);
    if (textIn(body, 'status') === 'ok') {
      const signIn = signInOf({ ...body, server });
      if (signIn === undefined) throw new CliError('The pool answered a sign-in with no account, token, or signing key.', ExitCode.UNEXPECTED, LOGIN);
      return signIn;
    }
    if (Reflect.get(body, 'slowDown') === true) intervalMs += SLOW_DOWN_MS;
  }
  const title = 'The sign-in code expired. Run oars pool login again.';
  throw new CliError(title, ExitCode.AUTH, LOGIN, { code: 'EXPIRED_TOKEN', title });
};

/** `oars pool login`: the provider's device flow through the pool, which keeps the provider's token and hands back its own. */
export const poolLogin = async (deps: RunDeps, options: { server?: string | undefined; provider?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, LOGIN, options.server);
  const { provider } = options;
  if (provider === undefined || !POOL_PROVIDERS.some((name) => name === provider)) throw usage(`The provider is one of ${POOL_PROVIDERS.join(', ')}.`, LOGIN);
  const saved = await loadSignIns(storeDir, LOGIN);
  const device = deviceOf(await ask(deps, LOGIN, server, '/v1/login/start', { body: { provider } }));
  deps.io.stderr(`To sign in, open ${device.verificationUri}\nand confirm the code ${device.userCode}\n`);
  await deps.openBrowser(device.verificationUri).catch(() => {
    deps.io.stderr('Could not open a browser; open the link above yourself.\n');
  });
  const signIn = await awaitSignIn(deps, server, provider, device);
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
  // A client past `registry_max_age` builds no batch (spec Section 1.3): the projection functions will run here once the deposit calls them (the skeleton below still sends the joined frame), so its sessions wait in `A` and nothing
  // is lost. This comes before the first request, so nothing leaves the machine.
  if (isVocabularyExpired(new Date(deps.now()))) {
    const title = `This oars is out of date: its vocabulary ${VOCAB_VERSION} was taken on ${VOCAB_SNAPSHOT_DATE}, over ${String(REGISTRY_MAX_AGE_DAYS)} days ago. Upgrade with npm install -g @manyoars/oars, then run oars pool deposit again. Your sessions stay on this machine.`;
    throw new CliError(title, ExitCode.CONFLICT, DEPOSIT, { code: 'vocabulary_expired', title, status: 409 });
  }
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

const replicaFile = (storeDir: string, server: string, stack: string): string => join(storeDir, 'pool-replica', contentHash(server), `${encodeURIComponent(stack)}.json`);

/** `oars pool pull`: one stack's signed slice, kept only once the key pinned at login has verified it. It keeps the signed form, so the replica can be checked again later. */
export const poolPull = async (deps: RunDeps, options: { server?: string | undefined; stack: string }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, PULL, options.server);
  const { stack } = options;
  if (!isStack(stack)) throw usage(`No stack is named ${stack}.`, PULL);
  const { token, signingKey } = await signedIn(deps, storeDir, server, PULL);
  const reply = await ask(deps, PULL, server, `/v1/slices/${encodeURIComponent(stack)}`, { token });
  if (reply.status !== 200) throw refusal(PULL, reply);
  const verified = await verifySlice(reply.body, signingKey, stack);
  if (!verified.ok) {
    const title = `Refused the slice: ${verified.reason}.`;
    throw new CliError(title, ExitCode.INVALID, PULL, { code: 'slice_unverified', title });
  }
  const file = replicaFile(storeDir, server, stack);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(reply.body)}\n`);
  const { cells, motifs, reads, capped, asOf } = verified.slice;
  const cappedLine = capped === null ? '' : ` Capped: ${String(capped.served)} of ${String(capped.limit)} reads served to this account; a deposit lifts the cap.`;
  return {
    document: { ok: true, server, stack, file, cells: cells.length, motifs: motifs.length, reads: reads.length, capped, asOf },
    text: `Pulled ${stack}: ${String(reads.length)} reads, ${String(cells.length)} cells, and ${String(motifs.length)} motifs, verified against the pinned key and kept at ${file}.${cappedLine}`,
  };
};
