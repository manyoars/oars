// The first sale's sample pack (P98 (10) to (12)): a local folder of an operator's own sessions, for the operator to read before any buyer sees one.
// Nothing here sends anything: it reads a sessions store and the harness's transcripts, and writes one folder that must sit outside every repository.
// Order, per session: the exclusion gate (A38) first, then a known owner and known harness terms, then the copy, with every injected block stripped.
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfigDir } from '../../cli/src/credentials.js';
import { checkSession, transcriptFilesOf, type Reason } from '../../cli/src/sessions/exclusion.js';
import { localNames, redactTranscript, REDACTION_VERSION } from '../../cli/src/sessions/redact.js';
import { harnessOf, type Harness } from '../../cli/src/sessions/schema.js';
import { loadStore, readRedactDomains, type SessionsRuntime } from '../../cli/src/sessions/store.js';

export const USAGE = [
  'Usage: sample-pack --terms <file> --owners <file> --index-key <file> --buyer-key <key> --out <dir> [--size <n>] [--seed <text>]',
  '  --terms <file>       the exclusion term list (one term per line; a local file, never in a repository)',
  '  --owners <file>      JSON list of {"folder": "<glob over the project folder name>", "owner": "<company>", "license": "<SPDX id>" | null}; first match wins, and a session in a folder no entry names is left out',
  '  --index-key <file>   the matching-index key (64 hex characters or more): a session\'s server key is HMAC-SHA-256 of its id under it. Keep it; a new key gives every session new ids',
  '  --buyer-key <key>    the buyer\'s key: a match id is HMAC-SHA-256 of the server key under it',
  '  --out <dir>          an empty or new folder outside every git repository',
  '  --size <n>           sessions to emit (default 25); --seed <text> orders the draw (default 1)',
  'Reads the store under APPDATA (or XDG_CONFIG_HOME) and the transcripts under CLAUDE_CONFIG_DIR or ~/.claude; writes only --out.',
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

export interface ManifestRow {
  matchId: string;
  session: string;
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
}

export interface PackCounts {
  /** Main sessions with a user turn in the store: what the draw runs over. */
  frame: number;
  /** Sessions the exclusion gate read, in draw order, until `size` were emitted or the frame ran out. */
  scanned: number;
  excluded: { term: number; noRaw: number; noTerms: number; unreadable: number };
  noOwner: number;
  noHarnessTerms: number;
  emitted: number;
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

const EXCLUDED: { readonly [reason in Exclude<Reason, 'clean'>]: keyof PackCounts['excluded'] } = { term: 'term', 'no-raw': 'noRaw', 'no-terms': 'noTerms', unreadable: 'unreadable' };

/** Where a transcript goes under the session's folder: `main.jsonl`, or its path under the session (`subagents/agent-x.jsonl`). */
const placeOf = (key: string, session: string, main: boolean): string => (main ? 'main.jsonl' : key.slice(session.length + 1));

export const buildPack = async (runtime: SessionsRuntime, options: PackOptions): Promise<PackCounts> => {
  if (insideRepository(options.out)) throw new PackError('The output folder is inside a git repository. Choose one outside every repository: a pack is never committed.');
  if (!(await isEmptyOrAbsent(options.out))) throw new PackError('The output folder is not empty. Choose a new folder, so one pack never mixes with another.');
  const owners = parseOwners(await readFile(options.owners, 'utf8'));
  const indexKey = await readIndexKey(options.indexKey);
  const domains = await readRedactDomains(runtime.storeDir);
  const names = localNames();
  // One injected-block key per buyer: within a pack the same CLAUDE.md gives the same marker, and two buyers' markers cannot be compared.
  const injectedKey = `injected-block:${createHmac('sha256', options.buyerKey).update('injected-block').digest('hex')}`;
  const store = await loadStore(runtime.storeDir);
  const frame = store.sessions.filter((session) => session.userTurns > 0);
  const order = (session: string): string => createHash('sha256').update(`${options.seed}\n${session}`).digest('hex');
  const drawn = frame.map((session) => ({ session, rank: order(session.session) })).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const counts: PackCounts = { frame: frame.length, scanned: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 }, noOwner: 0, noHarnessTerms: 0, emitted: 0 };
  const rows: ManifestRow[] = [];
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
    const matchId = matchIdOf(options.buyerKey, serverKeyOf(indexKey, record.session));
    const files = await transcriptFilesOf(runtime, record.project, record.session);
    for (const file of files) {
      const target = join(options.out, 'sessions', matchId, placeOf(file.key, record.session, file.main));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, redactTranscript(await readFile(file.path, 'utf8'), domains, names, injectedKey).text);
    }
    rows.push({
      matchId,
      session: record.session,
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
  await mkdir(options.out, { recursive: true });
  await writeFile(join(options.out, 'manifest.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  await writeFile(join(options.out, 'pack.json'), `${JSON.stringify({ built: new Date().toISOString(), size: options.size, seed: options.seed, redactionVersion: REDACTION_VERSION, counts }, null, 2)}\n`);
  return counts;
};

export interface Io {
  runtime: SessionsRuntime;
  print: (text: string) => void;
}

const VALUED = new Set(['--terms', '--owners', '--index-key', '--buyer-key', '--out', '--size', '--seed']);

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
  return { terms, owners, indexKey, buyerKey, out, size, seed: values.get('--seed') ?? '1' };
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
        `Left out after the gate: ${String(counts.noOwner)} in a folder no owner entry names, ${String(counts.noHarnessTerms)} from a harness with no terms row.`,
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
