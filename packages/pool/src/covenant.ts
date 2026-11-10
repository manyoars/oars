// The covenant gate. It lives at the server because a live URL is reachable by anyone and a CLI check would not hold: with no COVENANT_VERSION nothing can deposit, and once one is set an account must have accepted exactly that version.
import { createHash } from 'node:crypto';
import { COVENANT_TEXTS } from './covenant-texts.js';
import { answer, bodyOf, bound, refuse, textField, type Bound, type Env } from './http.js';
import { accountOf } from './identity.js';
import { callerOf } from './machines.js';

export const depositsClosed = (): Response => refuse(403, 'deposits_closed', 'This pool is not taking deposits: its covenant is not published.');

export const covenantNotAccepted = (version: string): Response => refuse(403, 'covenant_not_accepted', `Accept covenant ${version} before depositing.`);

/** An older acceptance does not carry over: a new version asks again. */
export const hasAccepted = async (env: Env, account: string, version: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT covenant FROM accounts WHERE id = ?').bind(account).first();
  return textField(row, 'covenant') === version;
};

/**
 * The statement that records the time the pool first served a version, so the funnel's start is on record without anyone remembering a deploy step. It rides on the two routes that name the version in force and writes nothing when none is set. `INSERT OR IGNORE`
 * writes no row once the version is there, so the first time never moves and a read after the first costs one statement that changes nothing.
 */
export const servedOf = (env: Env, version: string): Bound => env.DB.prepare('INSERT OR IGNORE INTO covenant_served (version, first_served_at) VALUES (?, ?)').bind(version, Date.now());

/** What a person is shown before they accept: the text exactly as displayed, the full-text link and the phrase to type (both read from that text), and the hash of the text, which the acceptance names. */
export interface Screen {
  text: string;
  link: string;
  phrase: string;
  sha256: string;
}

/** The two lines a screen must carry, so the client prints and asks for what the text itself states. */
const LINK_LINE = /^Full text: (\S+)$/m;
const PHRASE_LINE = /^To accept, type: (.+)$/m;

export const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The screen for a version, or `null` when no text is held for it or the text names no link or phrase: with no screen nothing can be shown, so nothing can be accepted. */
export const screenOf = (version: string, texts: ReadonlyMap<string, string>): Screen | null => {
  const text = texts.get(version);
  const link = text === undefined ? undefined : LINK_LINE.exec(text)?.[1];
  const phrase = text === undefined ? undefined : PHRASE_LINE.exec(text)?.[1];
  return text === undefined || link === undefined || phrase === undefined ? null : { text, link, phrase, sha256: sha256Of(text) };
};

/** `GET /v1/covenant`: the version is public, so it answers with no sign-in, and `accepted` is then simply false. The screen rides with it, from a file in this package keyed by version, so a change of text is a pool deploy and never a client release. */
export const covenantStatus = async (request: Request, env: Env, texts: ReadonlyMap<string, string> = COVENANT_TEXTS): Promise<Response> => {
  const version = bound(env.COVENANT_VERSION);
  // A machine's key reads its account's acceptance, and learns when it ends; a key that is not live is refused by name, as at a deposit, even before a covenant is published.
  const caller = await callerOf(request, env, Date.now());
  if (caller instanceof Response) return caller;
  const expires = caller?.machine === undefined ? {} : { machineExpiresAt: caller.machine.expiresAt };
  if (version === undefined) return answer(200, { version: null, accepted: false, ...expires });
  await servedOf(env, version).run();
  return answer(200, { version, accepted: caller !== undefined && (await hasAccepted(env, caller.account, version)), screen: screenOf(version, texts), ...expires });
};

/**
 * The two-letter country Cloudflare reports for a request (`request.cf.country`), or `null` when it gives none or something that is not two capital letters. Two letters name a country, not a person, and the covenant lists the country among the identifiers it keeps (Annex C.1).
 * Cloudflare also reports `XX` (no data) and `T1` (Tor); they are kept as they come, since neither is a protected region.
 */
export const countryOf = (request: Request): string | null => {
  const cf: unknown = Reflect.get(request, 'cf');
  const country: unknown = typeof cf === 'object' && cf !== null ? Reflect.get(cf, 'country') : undefined;
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
};

/**
 * The countries the pool does not take acceptances from while `PROTECTED_REGIONS_OPEN` is not `1`: the 27 EU member states and the EU territory with its own code (Åland and the French outermost regions), Iceland, Liechtenstein, and Norway (the EEA), and the United Kingdom (`GB`). Many Oars Co. has no representative in the EU or the UK (Article 27 of the GDPR and the UK GDPR), so it takes no acceptance from a person there until it appoints one.
 */
export const PROTECTED_REGIONS: ReadonlySet<string> = new Set([
  ...['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'],
  // EU territory that Cloudflare reports under its own ISO code: Åland, and the French outermost regions.
  ...['AX', 'GF', 'GP', 'MQ', 'RE', 'YT', 'MF'],
  ...['IS', 'LI', 'NO', 'GB'],
]);

const regionClosed = (): Response => refuse(403, 'region_closed', 'Many Oars cannot take deposits from the EU, the EEA, or the UK yet. If you are not there, write to privacy@manyoars.com.');

/** The longest `input` or `client` an acceptance may state: a name and a version, so a row stays small whatever a caller sends. */
const PROOF_FIELD_MAX = 64;

/**
 * `POST /v1/covenant/accept`: naming the version is the acceptance, so a client that read an older one cannot accept a newer one it never saw. The record exists to prove which text the person accepted, so the pool accepts only a version whose text it holds, and only when the body names the hash of that text (the text the client printed above the prompt), how the person answered, and the client.
 * With no text held an acceptance would prove nothing, so it is refused the way deposits are with no covenant at all.
 */
export const covenantAccept = async (request: Request, env: Env, texts: ReadonlyMap<string, string> = COVENANT_TEXTS): Promise<Response> => {
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const body = await bodyOf(request);
  const named = textField(body, 'version');
  if (named === undefined) return refuse(400, 'missing_field', 'An acceptance names its version.', 'version');
  if (named !== version) return refuse(409, 'covenant_version', `The covenant in force is ${version}, not ${named}.`, 'version');
  const screen = screenOf(version, texts);
  if (screen === null) return depositsClosed();
  const shown = textField(body, 'textSha256');
  if (shown === undefined) return refuse(400, 'missing_field', 'An acceptance names the hash of the text it showed.', 'textSha256');
  if (shown !== screen.sha256) return refuse(409, 'covenant_text', `The text you saw is not the text of covenant ${version}.`, 'textSha256');
  const input = textField(body, 'input');
  if (input === undefined || input.length > PROOF_FIELD_MAX) return refuse(400, 'missing_field', `An acceptance states how the person answered, in at most ${String(PROOF_FIELD_MAX)} characters.`, 'input');
  const client = textField(body, 'client');
  if (client === undefined || client.length > PROOF_FIELD_MAX) return refuse(400, 'missing_field', `An acceptance names its client, in at most ${String(PROOF_FIELD_MAX)} characters.`, 'client');
  const answered = textField(body, 'euEeaUk');
  if (answered !== 'yes' && answered !== 'no') return refuse(400, 'missing_field', 'An acceptance states whether the person is in the EU, the EEA, or the UK: yes or no.', 'euEeaUk');
  // Closed unless the operator sets the variable to exactly `1`. The person's answer and the request's country are two checks because neither stands for the other: a person may be in the EU behind an address elsewhere, and a request from an EU data center may carry a person who is not.
  const country = countryOf(request);
  if (env.PROTECTED_REGIONS_OPEN !== '1' && (answered === 'yes' || (country !== null && PROTECTED_REGIONS.has(country)))) return regionClosed();
  // One transaction: the history row and the column the gate reads change together, and a repeat of a version on record keeps its first time and its first proof (`OR IGNORE`). A client that accepts without reading first still leaves the version's start on record.
  await env.DB.batch([
    servedOf(env, version),
    env.DB.prepare('INSERT OR IGNORE INTO covenant_acceptances (account, version, accepted_at, text_sha256, input, client, eu_eea_uk, request_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(account, version, Date.now(), shown, input, client, answered, country),
    env.DB.prepare('UPDATE accounts SET covenant = ? WHERE id = ?').bind(version, account),
  ]);
  return answer(200, { ok: true, version });
};
