// Serving a bundle: one harness version's cells, derived and signed. The signature covers the exact payload bytes and the client pinned the public half at login, so a replica can be
// kept and checked again anywhere.
import { type Bundle, isBundleVersion, isHarness, type SignedBundle, VOCAB_VERSION, BUNDLE_FORMAT } from '../../cli/src/sessions/pool-wire.js';
import { CALL_SHAPE_METHOD, contentHash, METHODS } from '../../cli/src/sessions/read.js';
import { EXTRACTOR_VERSION } from '../../cli/src/sessions/schema.js';
import { accessOf } from './access.js';
import { bundleOf, SERVED } from './derive.js';
import { floorsOf, wireFloors, type Floors } from './floors.js';
import { answer, bound, fieldOf, notConfigured, refuse, textField, wholeBinding, type Env } from './http.js';
import { accountOf } from './identity.js';
import { storedOf } from './stored.js';
import { isoWeekOf, secondsToNextWeek } from './week.js';

const signed = async (bundle: Bundle, privateJwk: string): Promise<SignedBundle> => {
  const parsed: unknown = JSON.parse(privateJwk);
  const key = await crypto.subtle.importKey('jwk', { kty: textField(parsed, 'kty') ?? '', crv: textField(parsed, 'crv') ?? '', x: textField(parsed, 'x') ?? '', d: textField(parsed, 'd') ?? '' }, 'Ed25519', false, ['sign']);
  const payload = JSON.stringify(bundle);
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  return { payload, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

/** One fetch a week unless the deploy sets more. */
const DEFAULT_FETCH_CAP = 1;

/** The count of changes to the stored cells and strata, kept by triggers on them so it moves in the same write as the change. A write to the ledger plane does not move it. */
const generationOf = async (env: Env): Promise<number> => {
  const held = fieldOf(await env.DB.prepare('SELECT generation FROM pool_generation WHERE id = 1').bind().first(), 'generation');
  return typeof held === 'number' ? held : 0;
};

/**
 * What names this bundle: the code that derives it (the methods and the list of families it derives), the floors (public, clear, and disclosure, and any a family has of its own), the harness and version asked for, and the generation of the rows. It is known without reading a row, so a conditional request
 * costs no parse and an account cannot force one by sending it. Read before the rows, so a bundle is never older than the ETag it carries.
 */
export const etagOf = (harness: string, harnessVersion: string, generation: number, families: readonly string[], floors: Floors): string => `"${contentHash([BUNDLE_FORMAT, EXTRACTOR_VERSION, METHODS, CALL_SHAPE_METHOD, families, wireFloors(floors), harness, harnessVersion, VOCAB_VERSION, generation])}"`;

/** Whether an If-None-Match names this ETag. A proxy that compresses may weaken it to `W/"..."`, so the prefix is not compared. */
const matches = (header: string | null, etag: string): boolean => (header ?? '').split(',').some((token) => token.trim().replace(/^W\//, '') === etag);

/**
 * Spends one of the account's fetches this ISO week; false when none is left. One statement, so two fetches at once cannot both take the last. A count from an earlier week is
 * replaced by this fetch's, and an account at its cap is not touched. A count from a later week (a request that computed its week just before Monday) is not touched either, or it
 * would be rewritten to the old week's.
 */
const spend = async (env: Env, account: string, week: string, cap: number): Promise<boolean> => {
  const { meta } = await env.DB.prepare('UPDATE accounts SET fetches = CASE WHEN fetch_week = ? THEN fetches + 1 ELSE 1 END, fetch_week = ? WHERE id = ? AND (fetch_week IS NULL OR fetch_week < ? OR (fetch_week = ? AND fetches < ?))').bind(week, week, account, week, week, cap).run();
  return meta.changes === 1;
};

/** Drops the counts of an earlier week, through the `accounts_by_fetch_week` index, so it reads no row of an account that has a current count. Exported so a test can ask SQLite for its plan. */
export const WEEK_RESET = 'UPDATE accounts SET fetch_week = NULL, fetches = 0 WHERE fetch_week < ?';

/** A request that names no harness: a version number does not name its harness, so the route has no default and says what to send. */
export const harnessRequired = (): Response => refuse(400, 'harness_required', 'Name the harness: /bundle/<harness>/<harnessVersion>/<vocabVersion>.', 'harness');

/** The harness is a path segment of its own: a number does not name it, and two harnesses can share a numbered bucket, so a request that leaves it out is refused rather than answered with one. */
export const fetchBundle = async (request: Request, env: Env, harness: string, harnessVersion: string, vocabVersion: string): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!isHarness(harness)) return refuse(400, 'unknown_harness', 'That is not a harness this pool serves.', 'harness');
  if (!isBundleVersion(harnessVersion)) return refuse(400, 'unknown_harness_version', 'That is not a public harness version.', 'harnessVersion');
  if (vocabVersion !== VOCAB_VERSION) return refuse(400, 'unknown_vocab_version', `This pool holds vocabulary version ${VOCAB_VERSION}.`, 'vocabVersion');
  const key = bound(env.BUNDLE_SIGNING_KEY);
  if (key === undefined) return notConfigured('BUNDLE_SIGNING_KEY');
  const generation = await generationOf(env);
  // Read from the bindings on each request, so a deploy that moves a floor moves the ETag with it and a cached bundle is not reused across the change.
  const floors = floorsOf(env, (line) => {
    console.warn(line);
  });
  const etag = etagOf(harness, harnessVersion, generation, [...SERVED.map(({ name }) => name), 'books'], floors);
  // Before the spend and before the pool is read: a bundle that has not changed is not sent, so it costs the account nothing.
  if (matches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers: { etag } });
  const now = Date.now();
  const week = isoWeekOf(now);
  const cap = wholeBinding(env.FETCH_CAP, DEFAULT_FETCH_CAP);
  // Answered before the pool is read: a spent account must not be able to force a read on each request. An account with access has no cap.
  const capped = (await accessOf(env, account, now)) === null;
  if (capped && !(await spend(env, account, week, cap))) {
    return refuse(429, 'fetch_cap', `An account without access may fetch ${String(cap)} per ISO week. A deposit that counts lifts the cap.`, undefined, { 'retry-after': String(secondsToNextWeek(now)) });
  }
  try {
    // The count is dropped when its week ends, so what stays per account is only this week's. Earlier only (`<`, and `YYYY-Www` orders): a request that computed its week just before Monday must not wipe a count already spent in the new week.
    await env.DB.prepare(WEEK_RESET).bind(week).run();
    return answer(200, await signed(bundleOf(harness, harnessVersion, await storedOf(env, harness, harnessVersion, floors, now), floors), key), { etag });
  } catch (error) {
    // The spend came first so two fetches at once cannot both take the last, but a 304 spends nothing because it sends no bundle, and neither does a fetch that throws.
    if (capped) await env.DB.prepare('UPDATE accounts SET fetches = fetches - 1 WHERE id = ? AND fetch_week = ? AND fetches > 0').bind(account, week).run();
    throw error;
  }
};
