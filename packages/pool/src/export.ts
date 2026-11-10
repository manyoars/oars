// An account's copy of what the pool holds about it (GDPR Articles 15(3) and 20): `GET /v1/account/export`, a cursor-paged JSON read of every table that carries the account's own rows except `contributors` (shared totals, Article 15(4)), and `GET /v1/account/export/raw/:hash`, one raw object of the account's own.
// Both are account-only (a machine key is refused before they run) and write nothing. The account always comes from the sign-in, never from the cursor or the path, so no request can reach another account's row.
// Pooled derived cells and bundle reads are shared totals, not the account's own records, and are not here. No credential is: a token appears as when it ends, a machine as its record without its key hashes.
import { answer, fieldOf, notConfigured, refuse, type Env } from './http.js';
import { accountOf } from './identity.js';
import { objectKey } from './raw.js';
import { isErased, rawDigest } from './tombstones.js';

/** What a person's tools check before they read a page. A change to a page's shape moves `version`. */
const FORMAT = 'oars-pool-account-export';
const VERSION = 1;

/** The most rows one page carries, by section. A deposit holds up to 1 MB, so its pages are short enough to stay inside the Worker's response and D1's result limits; the rest are small rows. */
const DEPOSIT_PAGE = 10;
const SMALL_PAGE = 500;

type Key = readonly (string | number)[];

/** One slice of the account's records: the table it reads, how the rows are ordered (which is also what a cursor holds), and how a row is written out. */
interface Section {
  name: string;
  /** What the statement selects. */
  select: string;
  table: string;
  /** The column the account is matched on. */
  owner: string;
  /** The ordering columns, in the select's terms; a cursor holds the last row's values for them. */
  order: readonly string[];
  /** The selected names those columns come back as. */
  keyed: readonly string[];
  page: number;
  view: (row: unknown, account: string) => object;
}

const text = (row: unknown, name: string): string | null => {
  const found = fieldOf(row, name);
  return typeof found === 'string' ? found : null;
};

const count = (row: unknown, name: string): number | null => {
  const found = fieldOf(row, name);
  return typeof found === 'number' ? found : null;
};

/** A column that holds JSON, read as the value it holds. Text that is not JSON stays as text, so one bad row never stops the export. */
const json = (row: unknown, name: string): unknown => {
  const found = text(row, name);
  if (found === null) return null;
  try {
    return JSON.parse(found);
  } catch {
    return found;
  }
};

/** The sections in the order a read walks them: the account itself, then small records, then the raw ledger, and the deposits last because they are the largest. */
const SECTIONS: readonly Section[] = [
  {
    name: 'account',
    select: 'id, covenant, raw_consent, access, source, first_seen, provider_created, fetch_week, fetches, raw_consent_version, raw_consent_withdrawn_at, raw_consent_withdrawn_version, closed_at',
    table: 'accounts',
    owner: 'id',
    order: ['id'],
    keyed: ['id'],
    page: SMALL_PAGE,
    view: (row) => ({ id: text(row, 'id'), covenant: text(row, 'covenant'), rawConsent: count(row, 'raw_consent'), access: text(row, 'access'), source: text(row, 'source'), firstSeen: count(row, 'first_seen'), providerCreated: count(row, 'provider_created'), fetchWeek: text(row, 'fetch_week'), fetches: count(row, 'fetches'), rawConsentVersion: text(row, 'raw_consent_version'), rawConsentWithdrawnAt: count(row, 'raw_consent_withdrawn_at'), rawConsentWithdrawnVersion: text(row, 'raw_consent_withdrawn_version'), closedAt: count(row, 'closed_at') }),
  },
  // When a sign-in ends and nothing else: the hash that is the credential's only stored form is not selected.
  { name: 'tokens', select: 'rowid AS n, expires_at', table: 'tokens', owner: 'account', order: ['rowid'], keyed: ['n'], page: SMALL_PAGE, view: (row) => ({ expiresAt: count(row, 'expires_at') }) },
  {
    name: 'covenant',
    select: 'version, accepted_at, text_sha256, input, client, eu_eea_uk, request_country',
    table: 'covenant_acceptances',
    owner: 'account',
    order: ['version'],
    keyed: ['version'],
    page: SMALL_PAGE,
    view: (row) => ({ version: text(row, 'version'), acceptedAt: count(row, 'accepted_at'), textSha256: text(row, 'text_sha256'), input: text(row, 'input'), client: text(row, 'client'), euEeaUk: text(row, 'eu_eea_uk'), requestCountry: text(row, 'request_country') }),
  },
  // Every machine the account enrolled, a revoked one too, as its record: the key hashes (`key_hash`, `retired_hash`) are credential material and are not selected.
  {
    name: 'machines',
    select: 'id, label, host_class, launcher, allow_repos, state, expires_at, fingerprint_hash, created_at, activated_at, rotated_at, last_deposit_day, key_days',
    table: 'machines',
    owner: 'account',
    order: ['id'],
    keyed: ['id'],
    page: SMALL_PAGE,
    view: (row) => ({
      id: text(row, 'id'),
      label: text(row, 'label'),
      hostClass: text(row, 'host_class'),
      launcher: text(row, 'launcher'),
      allowRepos: json(row, 'allow_repos'),
      state: text(row, 'state'),
      expiresAt: count(row, 'expires_at'),
      fingerprintHash: text(row, 'fingerprint_hash'),
      createdAt: count(row, 'created_at'),
      activatedAt: count(row, 'activated_at'),
      rotatedAt: count(row, 'rotated_at'),
      lastDepositDay: text(row, 'last_deposit_day'),
      keyDays: count(row, 'key_days'),
    }),
  },
  { name: 'repoKeys', select: 'repo_key', table: 'account_repo_keys', owner: 'account', order: ['repo_key'], keyed: ['repo_key'], page: SMALL_PAGE, view: (row) => ({ repoKey: text(row, 'repo_key') }) },
  { name: 'depositHours', select: 'day, hour', table: 'deposit_hours', owner: 'account', order: ['day', 'hour'], keyed: ['day', 'hour'], page: SMALL_PAGE, view: (row) => ({ day: text(row, 'day'), hour: count(row, 'hour') }) },
  {
    name: 'telemetry',
    select: 'day, install, batches, events, measures',
    table: 'telemetry_install_days',
    owner: 'account',
    order: ['day', 'install'],
    keyed: ['day', 'install'],
    page: SMALL_PAGE,
    view: (row) => ({ day: text(row, 'day'), install: text(row, 'install'), batches: count(row, 'batches'), events: count(row, 'events'), measures: json(row, 'measures') }),
  },
  // The ledger names each raw object the account deposited. A row whose object was erased stays, marked with the day it was erased.
  {
    name: 'rawLedger',
    select: 'sha256, bytes, capture_version, redaction_version, stored_at, erased_on',
    table: 'raw_objects',
    owner: 'account',
    order: ['sha256'],
    keyed: ['sha256'],
    page: SMALL_PAGE,
    view: (row, account) => ({ key: objectKey(account, text(row, 'sha256') ?? ''), sha256: text(row, 'sha256'), bytes: count(row, 'bytes'), captureVersion: text(row, 'capture_version'), redactionVersion: text(row, 'redaction_version'), storedAt: count(row, 'stored_at'), tombstone: text(row, 'erased_on') }),
  },
  // Parts of a batch the pool staged and has not yet assembled or swept: the account's own content until then, so it is here with its body.
  { name: 'depositParts', select: 'batch, part, count, staged_at, deposit, body', table: 'deposit_parts', owner: 'account', order: ['batch', 'part'], keyed: ['batch', 'part'], page: DEPOSIT_PAGE, view: (row) => ({ batch: text(row, 'batch'), part: count(row, 'part'), count: count(row, 'count'), stagedAt: count(row, 'staged_at'), deposit: text(row, 'deposit'), body: text(row, 'body') }) },
  // What erasure did for the account: the audit rows keyed to it, which hold a reason, a day, and counts and no content.
  { name: 'erasures', select: 'id, kind, reason, erased_on, rows_erased, objects_erased', table: 'erasure_audit', owner: 'account', order: ['id'], keyed: ['id'], page: SMALL_PAGE, view: (row) => ({ kind: text(row, 'kind'), reason: text(row, 'reason'), erasedOn: text(row, 'erased_on'), rowsErased: count(row, 'rows_erased'), objectsErased: count(row, 'objects_erased') }) },
  // The account's board counts (migration 0036): its own weekly counts, the clubs it sits in under the nickname it typed, the consent it gave to each, and standing granted to it by hand.
  {
    name: 'weeks',
    select: 'week, sessions, tool_steps, failed_steps, day_mask, harnesses',
    table: 'account_weeks',
    owner: 'account',
    order: ['week'],
    keyed: ['week'],
    page: SMALL_PAGE,
    view: (row) => ({ week: text(row, 'week'), sessions: count(row, 'sessions'), toolSteps: count(row, 'tool_steps'), failedSteps: count(row, 'failed_steps'), dayMask: count(row, 'day_mask'), harnesses: json(row, 'harnesses') }),
  },
  { name: 'clubs', select: 'club, nickname, joined_at', table: 'club_members', owner: 'account', order: ['club'], keyed: ['club'], page: SMALL_PAGE, view: (row) => ({ club: text(row, 'club'), nickname: text(row, 'nickname'), joinedAt: count(row, 'joined_at') }) },
  { name: 'clubConsents', select: 'id, club, text_sha256, accepted_at', table: 'club_consents', owner: 'account', order: ['id'], keyed: ['id'], page: SMALL_PAGE, view: (row) => ({ club: text(row, 'club'), textSha256: text(row, 'text_sha256'), acceptedAt: count(row, 'accepted_at') }) },
  { name: 'standing', select: 'granted_at, granted_by, reason', table: 'board_standing', owner: 'account', order: ['granted_at'], keyed: ['granted_at'], page: SMALL_PAGE, view: (row) => ({ grantedAt: count(row, 'granted_at'), grantedBy: text(row, 'granted_by'), reason: text(row, 'reason') }) },
  { name: 'clubAttempts', select: 'id, kind, at', table: 'club_attempts', owner: 'account', order: ['id'], keyed: ['id'], page: SMALL_PAGE, view: (row) => ({ kind: text(row, 'kind'), at: count(row, 'at') }) },
  { name: 'clubHides', select: 'id, club, nickname, hidden_at, hidden_by, reason, seated_at', table: 'club_hides', owner: 'account', order: ['id'], keyed: ['id'], page: SMALL_PAGE, view: (row) => ({ club: text(row, 'club'), nickname: text(row, 'nickname'), hiddenAt: count(row, 'hidden_at'), hiddenBy: text(row, 'hidden_by'), reason: text(row, 'reason'), seatedAt: count(row, 'seated_at') }) },
  // A deposit as it now reads: an erased one holds the marker the erasure left, and `tombstone` is the day it was erased.
  {
    name: 'deposits',
    select: 'id, tier, counted_at, format, vocab_version, fields_version, extensions, other_values, deltas, ingest, skeleton, erased_on, machine, host_class, launcher, claimed_host_class, claimed_launcher, request_country',
    table: 'deposits',
    owner: 'account',
    order: ['id'],
    keyed: ['id'],
    page: DEPOSIT_PAGE,
    view: (row) => ({
      id: text(row, 'id'),
      tier: text(row, 'tier'),
      countedAt: count(row, 'counted_at'),
      format: count(row, 'format'),
      vocabVersion: text(row, 'vocab_version'),
      fieldsVersion: count(row, 'fields_version'),
      extensions: json(row, 'extensions'),
      otherValues: count(row, 'other_values'),
      deltas: json(row, 'deltas'),
      ingest: text(row, 'ingest'),
      skeleton: json(row, 'skeleton'),
      tombstone: text(row, 'erased_on'),
      machine: text(row, 'machine'),
      hostClass: text(row, 'host_class'),
      launcher: text(row, 'launcher'),
      claimedHostClass: text(row, 'claimed_host_class'),
      claimedLauncher: text(row, 'claimed_launcher'),
      requestCountry: text(row, 'request_country'),
    }),
  },
];

/** A cursor is the section a page came from and the last row's ordering values, as base64url JSON. It is a position and nothing else, so one made up or taken from another account moves a read within the caller's own rows. */
const cursorOf = (section: Section, key: Key | undefined): string => Buffer.from(JSON.stringify({ s: section.name, a: key ?? [] })).toString('base64url');

interface Position {
  at: number;
  after: Key;
}

const positionOf = (cursor: string): Position | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const name = fieldOf(parsed, 's');
  const after = fieldOf(parsed, 'a');
  const at = SECTIONS.findIndex((section) => section.name === name);
  const section = SECTIONS[at];
  if (section === undefined || !Array.isArray(after) || !after.every((part) => typeof part === 'string' || typeof part === 'number')) return undefined;
  // Empty is the start of the section; anything else holds one value for each ordering column.
  return after.length === 0 || after.length === section.order.length ? { at, after } : undefined;
};

/** Runs one SELECT with its values and answers its rows: the Worker's D1 for the route, the operator's `wrangler d1 execute` for the script (`scripts/export-account.ts`). The page builder reads only through this, so the two cannot drift. */
export type ExportRows = (sql: string, binds: readonly (string | number)[]) => Promise<readonly unknown[]>;

/** The rows of one section after a position, one more than a page holds, so the caller can tell whether another page follows. */
const readSection = async (rows: ExportRows, section: Section, account: string, after: Key, limit: number): Promise<unknown[]> => {
  const order = section.order.join(', ');
  const past = after.length === 0 ? '' : ` AND (${order}) > (${after.map(() => '?').join(', ')})`;
  return [...(await rows(`SELECT ${section.select} FROM ${section.table} WHERE ${section.owner} = ?${past} ORDER BY ${order} LIMIT ?`, [account, ...after, limit + 1]))];
};

const LIMIT = /^[1-9][0-9]{0,5}$/;

/** One page of an account's export, as the route sends it and the operator's script writes it. */
export interface ExportPageBody {
  format: string;
  version: number;
  account: string;
  section: string;
  rows: object[];
  next: string | null;
}

/** A request the builder cannot read: the route answers it 400 with this code, message, and field. */
export interface ExportRefusal {
  code: string;
  message: string;
  field: string;
}

/** One page of the account's records. `asked` (optional) is `limit`, fewer rows than a page holds; `cursor` is the previous page's `next`. A page holds rows of one section, and the last page's `next` is null. The account is the caller's own, never read from the cursor. */
export const buildExportPage = async (account: string, asked: string | null, given: string | null, rows: ExportRows): Promise<ExportPageBody | ExportRefusal> => {
  if (asked !== null && !LIMIT.test(asked)) return { code: 'bad_limit', message: 'limit is a whole number of at least 1.', field: 'limit' };
  const start = given === null ? { at: 0, after: [] } : positionOf(given);
  if (start === undefined) return { code: 'bad_cursor', message: 'cursor is the next value of the previous page.', field: 'cursor' };
  let { at, after } = start;
  // A section with nothing left is passed over, so no page is empty but the last.
  for (;;) {
    const section = SECTIONS[at];
    // `at` starts at a section and only moves to the next while one follows, so this is the compiler's question, not a state a request reaches.
    if (section === undefined) throw new Error('the export walked past its last section');
    const size = Math.min(section.page, asked === null ? section.page : Number(asked));
    const read = await readSection(rows, section, account, after, size);
    const held = read.slice(0, size);
    const following = SECTIONS[at + 1];
    if (held.length === 0 && following !== undefined) {
      at += 1;
      after = [];
      continue;
    }
    const last = held.at(-1);
    const next = read.length > size ? cursorOf(section, section.keyed.map((name) => text(last, name) ?? count(last, name) ?? '')) : following === undefined ? null : cursorOf(following, undefined);
    return { format: FORMAT, version: VERSION, account, section: section.name, rows: held.map((row) => section.view(row, account)), next };
  }
};

/** `GET /v1/account/export`: one page of the account's records (`buildExportPage`). */
export const exportPage = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const query = new URL(request.url).searchParams;
  const built = await buildExportPage(account, query.get('limit'), query.get('cursor'), async (sql, binds) => (await env.DB.prepare(sql).bind(...binds).all()).results);
  if ('code' in built) return refuse(400, built.code, built.message, built.field);
  return answer(200, built, { 'cache-control': 'private, no-store' });
};

const SHA256 = /^[0-9a-f]{64}$/;

/** `GET /v1/account/export/raw/:hash`: one raw object the account deposited, byte for byte. Another account's object, one the pool never held, and one whose bytes are gone all answer 404, so the answer says nothing about who holds what; a tombstoned one answers 410, because the account's own ledger already says it was erased. */
export const exportRaw = async (request: Request, env: Env, hash: string): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (env.RAW === undefined) return notConfigured('RAW');
  const missing = (): Response => refuse(404, 'not_found', 'This account holds no raw object with this hash.');
  if (!SHA256.test(hash)) return missing();
  const row = await env.DB.prepare('SELECT erased_on FROM raw_objects WHERE account = ? AND sha256 = ?').bind(account, hash).first();
  if (row === null) return missing();
  const key = objectKey(account, hash);
  if (text(row, 'erased_on') !== null || (await isErased(env, 'raw-object', await rawDigest(key)))) return refuse(410, 'erased', 'This raw object was erased from the pool at the account\'s request or the operator\'s, and no copy remains.');
  const object = await env.RAW.get(key);
  if (object === null) return missing();
  return new Response(object.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
};
