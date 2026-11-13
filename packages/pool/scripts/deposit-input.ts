// The build's side of `pull-deposits` (docs/pool-deposit-title.md sections 1 and 2): read the folder it wrote, capture each Raw Copy into a throwaway store, pair each session with its deposit row, and decide what the title rule and the build rules leave out. Nothing here reaches the pool.
import { createHmac } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from '../../cli/src/sessions/read.js';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { PROTECTED_REGIONS } from '../src/covenant.js';
import { nameOf } from './erase.js';

export interface DepositAcceptance {
  version: string;
  text_sha256: string;
  accepted_at: number;
}

export interface DepositRow {
  id: string;
  tier: string;
  countedAt: number | null;
  country: string | null;
  skeleton: string;
}

export interface DepositAccount {
  account: string;
  acceptances: DepositAcceptance[];
  deposits: DepositRow[];
  /** Raw Copy hashes, the file names under `<account>/projects/deposit/`. */
  copies: string[];
  /** The stored link of a Raw Copy to its deposit (`raw_objects.deposit`), by Raw Copy hash. A copy stored before the column, or by a client that sent no link, has none. */
  links: Map<string, string>;
}

/** Why a Raw Copy of a deposit was left out, counted by name; absent from `PackCounts` unless the pack was built from deposits. */
export interface DepositCounts {
  /** Pairs with no deposit row of its account: its stored link names none, or it has no stored link and the recomputed id found none. */
  unlinked: number;
  /** The paired deposit arrived as tier `none`: its batch failed the challenge or root check. */
  tierNone: number;
  /** The paired deposit came from a protected region (Art. 44 to 46). Expected zero while the gate is closed. */
  protectedRegion: number;
  /** The account holds no proved acceptance, so no grant can be cited. */
  noGrant: number;
}

export const newDepositCounts = (): DepositCounts => ({ unlinked: 0, tierNone: 0, protectedRegion: 0, noGrant: 0 });

const objectOf = (value: unknown): object | undefined => (typeof value === 'object' && value !== null ? value : undefined);
const fieldOf = (row: unknown, key: string): unknown => {
  const found = objectOf(row);
  return found === undefined ? undefined : Reflect.get(found, key);
};
const textAt = (row: unknown, key: string): string => {
  const found = fieldOf(row, key);
  if (typeof found !== 'string') throw new Error(`The deposits folder holds a row with no text at ${key}.`);
  return found;
};
const textOrNull = (row: unknown, key: string): string | null => {
  const found = fieldOf(row, key);
  return typeof found === 'string' ? found : null;
};

const rowsOf = (text: string): unknown[] =>
  text
    .split('\n')
    .filter((row) => row !== '')
    .map((row): unknown => JSON.parse(row));

const acceptanceOf = (row: unknown): DepositAcceptance => {
  const at = fieldOf(row, 'accepted_at');
  if (typeof at !== 'number') throw new Error('The deposits folder holds an acceptance with no accepted_at.');
  return { version: textAt(row, 'version'), text_sha256: textAt(row, 'text_sha256'), accepted_at: at };
};

/** Reads what `pull-deposits` wrote: `accounts.jsonl`, then per account `deposits.jsonl`, `links.jsonl` (the stored Raw Copy links, when the pull wrote any), and the names under `projects/deposit/`. */
export const readDepositInput = async (folder: string): Promise<DepositAccount[]> => {
  const accounts: DepositAccount[] = [];
  for (const row of rowsOf(await readFile(join(folder, 'accounts.jsonl'), 'utf8'))) {
    const account = nameOf(textAt(row, 'account'), 'the account');
    const acceptances = fieldOf(row, 'acceptances');
    const deposits = rowsOf(await readFile(join(folder, account, 'deposits.jsonl'), 'utf8')).map((found): DepositRow => {
      const counted = fieldOf(found, 'counted_at');
      return { id: textAt(found, 'id'), tier: textAt(found, 'tier'), countedAt: typeof counted === 'number' ? counted : null, country: textOrNull(found, 'request_country'), skeleton: textAt(found, 'skeleton') };
    });
    // `links.jsonl` is absent from a pull made before the stored link, and then every copy is paired by the recomputed id.
    const links = new Map(rowsOf(await readFile(join(folder, account, 'links.jsonl'), 'utf8').catch(() => '')).map((found): [string, string] => [textAt(found, 'sha256'), textAt(found, 'deposit')]));
    const copies = await readdir(join(folder, account, 'projects', 'deposit')).catch((): string[] => []);
    accounts.push({ account, acceptances: Array.isArray(acceptances) ? acceptances.map(acceptanceOf) : [], deposits, copies: copies.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).sort(), links });
  }
  return accounts;
};

/** The acceptance a deposit cites (section 1): the account's newest with `accepted_at` at or before `counted_at`, else its newest. */
export const citedAcceptance = (acceptances: readonly DepositAcceptance[], countedAt: number | null): DepositAcceptance | undefined => {
  const newest = (list: readonly DepositAcceptance[]): DepositAcceptance | undefined => [...list].sort((a, b) => b.accepted_at - a.accepted_at || (a.version < b.version ? 1 : -1))[0];
  return (countedAt === null ? undefined : newest(acceptances.filter((found) => found.accepted_at <= countedAt))) ?? newest(acceptances);
};

/** `depositor:<16 hex>`: the HMAC-SHA-256 of the account id under the buyer key. Not the account id, and not the same value under another buyer's key. */
export const depositorOf = (buyerKey: string, account: string): string => `depositor:${createHmac('sha256', buyerKey).update(account).digest('hex').slice(0, 16)}`;

/** The license a deposit row names: the covenant version and the hash of the screen shown. */
export const covenantLicenseOf = (found: DepositAcceptance): string => `manyoars-covenant ${found.version} sha256:${found.text_sha256}`;

/** The harness id of a Raw Copy: the first `sessionId` any line carries. A pulled copy is named by its hash, so the store's session id is not it. */
export const harnessSessionOf = (text: string): string | undefined => {
  for (const row of text.split('\n')) {
    if (row === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      continue;
    }
    const id = fieldOf(parsed, 'sessionId');
    if (typeof id === 'string' && id !== '') return id;
  }
  return undefined;
};

/** What a paired Raw Copy carries into the pack row and the operator index. */
export interface Paired {
  account: string;
  /** The harness's own session id, from the Raw Copy's lines. */
  session: string;
  row: DepositRow;
  accepted: DepositAcceptance;
}

export type DepositVerdict = { left: keyof DepositCounts } | { paired: Paired };

export interface DepositBuild {
  /** The throwaway store and transcript folder the Raw Copies were captured into. */
  runtime: SessionsRuntime;
  counts: DepositCounts;
  /** The verdict of the title rule and the build rules for one captured session (the Raw Copy's hash), by account (the project). */
  verdictOf: (project: string, session: string) => DepositVerdict;
}

const KEYED = /"repoKey":"[0-9a-f]{16}"/;

/** The repository test of a deposit: its skeleton holds a repo key, since the build machine holds no clone (pool-wire.ts `where`). */
export const hasRepoKey = (paired: Paired): boolean => KEYED.test(paired.row.skeleton);

/**
 * Captures every Raw Copy of the folder into a throwaway store under `scratch`, each account's as its own project, with the CLI's own capture, and pairs each with its deposit row by the recomputed id.
 * The operator's redact domains ride along, so the second redaction pass over the pack sees the same set.
 */
export const captureDeposits = async (runtime: SessionsRuntime, folder: string, scratch: string, redactDomains: readonly string[], now: () => number): Promise<DepositBuild> => {
  const accounts = await readDepositInput(folder);
  const projectsRoot = join(scratch, 'projects');
  const sessionOf = new Map<string, string | undefined>();
  for (const found of accounts) {
    await mkdir(join(projectsRoot, found.account), { recursive: true });
    for (const sha of found.copies) {
      const target = join(projectsRoot, found.account, `${sha}.jsonl`);
      await copyFile(join(folder, found.account, 'projects', 'deposit', `${sha}.jsonl`), target);
      sessionOf.set(`${found.account}/${sha}`, harnessSessionOf(await readFile(target, 'utf8')));
    }
  }
  const scratchRuntime: SessionsRuntime = { ...runtime, storeDir: join(scratch, 'store'), projectsRoot };
  await deposit(scratchRuntime, { allow: [], redactDomains, now });
  const byAccount = new Map(accounts.map((found) => [found.account, found]));
  const counts = newDepositCounts();
  const verdictOf = (project: string, session: string): DepositVerdict => {
    const found = byAccount.get(project);
    const harness = sessionOf.get(`${project}/${session}`);
    // The stored link first: it is the client's own key for the session, exact for a machine's session too. A copy with none (older rows) is paired by the recomputed id.
    const stored = found?.links.get(session);
    const wanted = stored ?? (harness === undefined ? undefined : contentHash([project, harness]));
    const row = found === undefined || wanted === undefined ? undefined : found.deposits.find((candidate) => candidate.id === wanted);
    if (found === undefined || row === undefined) return { left: 'unlinked' };
    if (row.tier === 'none') return { left: 'tierNone' };
    if (row.country !== null && PROTECTED_REGIONS.has(row.country)) return { left: 'protectedRegion' };
    const accepted = citedAcceptance(found.acceptances, row.countedAt);
    return accepted === undefined ? { left: 'noGrant' } : { paired: { account: project, session: harness ?? '', row, accepted } };
  };
  return { runtime: scratchRuntime, counts, verdictOf };
};
