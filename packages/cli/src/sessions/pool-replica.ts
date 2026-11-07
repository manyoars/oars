// The kept pool bundle: where `oars pool fetch` keeps one harness version's signed bundle, the sign-ins whose pinned keys verify it, and the one reader every caller uses (t926).
// `poolFetch` reads it for its ETag, and recall, the MCP tool, and the hooks read it for the session's own harness and version. A reader for recall is fail-open: no bundle,
// one for another harness, or one that does not verify means local reads only, and nothing is printed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { isMissing } from './pool-outbox.js';
import { isBundleVersion, verifyBundle, type Bundle, type PinnedKey } from './pool-wire.js';
import { contentHash } from './read.js';
import type { Harness } from './schema.js';

export const textIn = (value: object, key: string): string | undefined => {
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'string' && found !== '' ? found : undefined;
};

export const numberIn = (value: object, key: string): number | undefined => {
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
};

export const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const keyOf = (value: unknown): PinnedKey | undefined => {
  if (!isObject(value)) return undefined;
  const [kty, crv, x] = [textIn(value, 'kty'), textIn(value, 'crv'), textIn(value, 'x')];
  return kty === 'OKP' && crv === 'Ed25519' && x !== undefined ? { kty, crv, x } : undefined;
};

/** One server's sign-in, as `login` saved it. */
export interface SignIn {
  server: string;
  account: string;
  token: string;
  expiresAt: number;
  /** Pinned at the first login to this server; every bundle is checked against it. */
  signingKey: PinnedKey;
}

export const signInOf = (value: unknown): SignIn | undefined => {
  if (!isObject(value)) return undefined;
  const [server, account, token, expiresAt] = [textIn(value, 'server'), textIn(value, 'account'), textIn(value, 'token'), numberIn(value, 'expiresAt')];
  const signingKey = keyOf(Reflect.get(value, 'signingKey'));
  return server === undefined || account === undefined || token === undefined || expiresAt === undefined || signingKey === undefined ? undefined : { server, account, token, expiresAt, signingKey };
};

export const signInsFile = (storeDir: string): string => join(storeDir, 'pool-accounts.json');

/** Every saved sign-in. A file that cannot be read stops the command: treating it as empty would forget a pin and trust whatever key the server names next. */
export const loadSignIns = async (storeDir: string, step: string): Promise<SignIn[]> => {
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

/** One folder per harness under the server's, so a fetch for one harness never overwrites another's bundle of the same version. */
export const replicaFile = (storeDir: string, server: string, harness: Harness, harnessVersion: string): string => join(storeDir, 'pool-replica', contentHash(server), harness, `${encodeURIComponent(harnessVersion)}.json`);

/** What an earlier fetch kept: the bundle, checked again against the pinned key, and the ETag the pool sent with it. Nothing readable and verified is nothing kept, and the next fetch is then an ordinary one. */
export const keptReplica = async (file: string, key: PinnedKey, harness: Harness, harnessVersion: string): Promise<{ etag: string | undefined; bundle: Bundle } | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  const verified = await verifyBundle(parsed, key, harness, harnessVersion);
  return verified.ok ? { etag: isObject(parsed) ? textIn(parsed, 'etag') : undefined, bundle: verified.bundle } : undefined;
};

/** A session's harness and the version it runs, as a hook input, a transcript, or the store states them. */
export interface Setup {
  harness: Harness;
  harnessVersion: string;
}

/**
 * The kept bundle for a session's own harness and version, from the first signed-in server that kept one which still verifies; undefined otherwise. It never throws: a damaged
 * sign-in file, a missing or corrupt replica, or one signed for another harness all mean the caller answers from the local store alone, and a hook must not fail on any of them.
 */
export const sessionBundle = async (storeDir: string, setup: Setup | undefined): Promise<Bundle | undefined> => {
  if (setup === undefined || !isBundleVersion(setup.harnessVersion)) return undefined;
  const signIns = await loadSignIns(storeDir, 'recall').catch((): SignIn[] => []);
  for (const { server, signingKey } of signIns) {
    const kept = await keptReplica(replicaFile(storeDir, server, setup.harness, setup.harnessVersion), signingKey, setup.harness, setup.harnessVersion);
    if (kept !== undefined) return kept.bundle;
  }
  return undefined;
};
