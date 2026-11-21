import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { datasets, purchases, type components } from '@manyoars/oars-client';
import { apiClient, unwrap } from '../api.js';
import { checkPack, readTar, UnsafePack, writeFiles, type TarFile } from '../data-pack.js';
import { CliError, ExitCode } from '../errors.js';
import { Masker } from '../sessions/pool-print.js';
import { ask, isObject, isTerminal, lineFrom, poolServer, refusal, runtimeOf, signedIn, textIn, type Reply } from '../sessions/pool-command.js';
import type { Outcome, RunDeps } from '../cli.js';

type Listing = components['schemas']['DatasetCatalogView'];

const SEARCH = 'data-search';
const FETCH = 'data-fetch';
const STATE = /^[A-Za-z]{2}$/;
/** A fetch id goes into a path and a URL, so it is the pool's own plain id or nothing. */
const FETCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** After a buy settles the pool may still answer 402 for a moment: the start is tried this many times more. */
const START_RETRIES = 4;
/** The wait between polls grows by half each time up to the longest, and the whole wait ends at its limit. */
const FIRST_WAIT_MS = 1000;
const LONGEST_WAIT_MS = 15_000;
const PURCHASE_LIMIT_MS = 2 * 60_000;
const FETCH_LIMIT_MS = 15 * 60_000;

export interface DataSearchOptions {
  apiUrl: string;
  query?: string | undefined;
  harness?: string | undefined;
  permittedUse?: string | undefined;
  training?: string | undefined;
  maxPricePerFetchUsd?: number | undefined;
}

const usd = (amount: string, digits = 2): string => `$${Number(amount).toFixed(digits)}`;

const describeListing = (row: Listing): string =>
  [
    row.listingId,
    row.sellerDisplayName,
    row.displayName,
    usd(row.amountUsd),
    `${String(row.fetches)} fetches`,
    `${usd(row.pricePerFetchUsd, 4)}/fetch`,
    `${String(row.sessionCount)} sessions`,
    `redaction ${row.redactionVersion}`,
  ].join('  ');

/** `GET /billing/datasets`: the public catalog; no credential. */
export const dataSearch = async (deps: RunDeps, options: DataSearchOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: SEARCH });
  const page = unwrap(
    SEARCH,
    await datasets.search(client, {
      ...(options.query === undefined ? {} : { q: options.query }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.permittedUse === undefined ? {} : { permittedUse: options.permittedUse }),
      ...(options.training === undefined ? {} : { training: options.training }),
      ...(options.maxPricePerFetchUsd === undefined ? {} : { maxPricePerFetchUsd: options.maxPricePerFetchUsd }),
    }),
  );
  return {
    document: { ok: true, datasets: page.content },
    text: page.content.length === 0 ? 'No datasets match.' : page.content.map(describeListing).join('\n'),
  };
};

export interface DataFetchOptions {
  apiUrl: string;
  listingId: string;
  /** A two-letter US state: the pool asks it for the region gate. */
  state: string;
  /** The folder the pack's own folder is made in; absent means a fresh temporary folder. */
  out?: string | undefined;
  yes: boolean;
  /** The most one buy may cost, in USD; absent leaves the cap to the platform, which refuses a buy over the agent's own. */
  maxUsd?: number | undefined;
  sdkKeyFile?: string | undefined;
  server?: string | undefined;
}

/** The buying agent's SDK key, from a file or `OARS_SDK_KEY`; read only when a buy is about to happen. */
const sdkKeyOf = async (deps: RunDeps, file?: string): Promise<string> => {
  const raw = file === undefined ? deps.env.OARS_SDK_KEY : await readFile(file, 'utf8').catch(() => undefined);
  const key = raw?.trim();
  if (key !== undefined && key !== '') return key;
  throw new CliError(file === undefined ? 'Buying needs the agent SDK key: set OARS_SDK_KEY or pass --sdk-key-file.' : `Cannot read an SDK key from ${file}.`, ExitCode.USAGE, FETCH);
};

/** The buyer's own pack key, made once and kept beside the sign-in: the pack's session ids are masked under it, so every pack needs the same key. */
const buyerKeyOf = async (storeDir: string): Promise<string> => {
  const file = join(storeDir, 'buyer-key');
  const kept = await readFile(file, 'utf8').catch(() => undefined);
  if (kept !== undefined && kept.trim() !== '') return kept.trim();
  const made = randomBytes(32).toString('hex');
  await mkdir(storeDir, { recursive: true });
  await writeFile(file, `${made}\n`, { mode: 0o600 });
  return made;
};

const waits = function* (limit: number): Generator<number> {
  let wait = FIRST_WAIT_MS;
  for (let spent = 0; spent < limit; spent += wait, wait = Math.min(LONGEST_WAIT_MS, Math.round(wait * 1.5))) yield wait;
};

const confirmed = async (deps: RunDeps, yes: boolean, question: string): Promise<boolean> => {
  if (yes) return true;
  if (!isTerminal(deps)) return false;
  deps.io.stderr(`${question} Type yes to buy: `);
  return (await lineFrom(runtimeOf(deps).stdin))?.trim().toLowerCase() === 'yes';
};

/** What a 402 asks of the buyer: the offer to buy and what is held now. */
interface PaymentRequired {
  offerId: string;
  priceRefs: string[];
  balance: string;
}

const paymentRequired = (reply: Reply): PaymentRequired => {
  const body = reply.body;
  const offerId = isObject(body) ? textIn(body, 'offerId') : undefined;
  const refs: unknown = isObject(body) ? Reflect.get(body, 'priceRefs') : undefined;
  if (offerId === undefined || !Array.isArray(refs)) throw new CliError('The pool asked for payment but named no offer.', ExitCode.UNEXPECTED, FETCH);
  const balance: unknown = isObject(body) ? Reflect.get(body, 'balance') : undefined;
  return { offerId, priceRefs: refs.filter((ref): ref is string => typeof ref === 'string'), balance: balance === undefined ? 'unknown' : JSON.stringify(balance) };
};

/** A purchase made and not yet turned into a fetch: a rerun polls it instead of buying a second credit. */
interface OpenPurchase {
  purchaseId: string;
  offerId: string;
  priceRef: string;
}

/** One record per pack, so a purchase of pack A is never closed by a fetch of pack B. */
const recordFile = (storeDir: string, priceRef: string): string => join(storeDir, `open-purchase-${createHash('sha256').update(priceRef).digest('hex')}.json`);

const openPurchaseOf = async (storeDir: string, priceRef: string): Promise<OpenPurchase | undefined> => {
  const file = recordFile(storeDir, priceRef);
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`The record of an open purchase, ${file}, cannot be read. Remove that file and run again.`, ExitCode.UNEXPECTED, FETCH);
  }
  if (!isObject(parsed)) return undefined;
  const purchaseId = textIn(parsed, 'purchaseId');
  const offerId = textIn(parsed, 'offerId');
  return purchaseId !== undefined && offerId !== undefined && textIn(parsed, 'priceRef') === priceRef ? { purchaseId, offerId, priceRef } : undefined;
};

const closePurchase = (storeDir: string, priceRef: string): Promise<void> => rm(recordFile(storeDir, priceRef), { force: true });

/**
 * Buys the offer's pack under the agent's SDK key and waits for the purchase to settle. Refuses over the cap, and never buys unconfirmed.
 * The purchase is recorded before the wait, so a rerun after a pending exit polls it and does not buy again.
 */
const buy = async (deps: RunDeps, options: DataFetchOptions, storeDir: string, listing: Listing, offer: PaymentRequired): Promise<void> => {
  const question = `The pool needs a credit: ${listing.displayName} is ${usd(listing.amountUsd)} for ${String(listing.fetches)} fetches (held now: ${offer.balance}).`;
  const open = await openPurchaseOf(storeDir, listing.priceRef);
  const sdkKey = await sdkKeyOf(deps, options.sdkKeyFile);
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: FETCH });
  let purchase: OpenPurchase;
  if (open === undefined) {
    if (options.maxUsd !== undefined && Number(listing.amountUsd) > options.maxUsd) {
      const title = `This pack costs ${usd(listing.amountUsd)}, over the ${usd(String(options.maxUsd))} cap you set. Nothing was bought.`;
      throw new CliError(title, ExitCode.CONFLICT, FETCH, { code: 'over_cap', title });
    }
    if (!offer.priceRefs.includes(listing.priceRef)) throw new CliError('The pool offered no pack for this listing. Nothing was bought.', ExitCode.UNEXPECTED, FETCH);
    // The offer is always shown, with --yes too, so what is bought is on the record.
    if (options.yes) deps.io.stderr(`${question}
`);
    if (!(await confirmed(deps, options.yes, question))) {
      const title = `${question} Nothing was bought: run again with --yes to buy it.`;
      throw new CliError(title, ExitCode.USAGE, FETCH, { code: 'buy_not_confirmed', title });
    }
    const made = unwrap(FETCH, await purchases.buy(client, { sdkKey, offerId: offer.offerId, priceRef: listing.priceRef }));
    purchase = { purchaseId: made.purchaseId, offerId: offer.offerId, priceRef: listing.priceRef };
    await mkdir(storeDir, { recursive: true });
    await writeFile(recordFile(storeDir, listing.priceRef), JSON.stringify(purchase), { mode: 0o600 });
    return settle(client, sdkKey, storeDir, purchase, made, deps);
  }
  deps.io.stderr(`Purchase ${open.purchaseId} was already made: waiting for it, not buying again.
`);
  purchase = open;
  return settle(client, sdkKey, storeDir, purchase, unwrap(FETCH, await purchases.get(client, { sdkKey, purchaseId: purchase.purchaseId })), deps);
};

const settle = async (client: ReturnType<typeof apiClient>, sdkKey: string, storeDir: string, purchase: OpenPurchase, first: { status: string; failureCode?: string | undefined }, deps: RunDeps): Promise<void> => {
  let current = first;
  for (const wait of waits(PURCHASE_LIMIT_MS)) {
    if (current.status !== 'PENDING') break;
    await deps.sleep(wait);
    current = unwrap(FETCH, await purchases.get(client, { sdkKey, purchaseId: purchase.purchaseId }));
  }
  if (current.status === 'PENDING') throw new CliError(`Purchase ${purchase.purchaseId} is still pending: run the command again to continue; it will not buy again.`, ExitCode.UNREACHABLE, FETCH);
  if (current.status !== 'SUCCEEDED') {
    await closePurchase(storeDir, purchase.priceRef);
    throw new CliError(`Purchase ${purchase.purchaseId} ${current.status}${current.failureCode === undefined ? '' : ` (${current.failureCode})`}. Nothing more was bought.`, ExitCode.CONFLICT, FETCH);
  }
};

/** The pack folder to write: `<out>/pack-<fetchId>` (made fresh, never reused), or a fresh temporary one. */
const freshFolder = async (out: string | undefined, fetchId: string): Promise<string> => {
  if (out === undefined) return mkdtemp(join(tmpdir(), 'oars-pack-'));
  const folder = join(resolve(out), `pack-${fetchId}`);
  await mkdir(resolve(out), { recursive: true });
  try {
    await mkdir(folder);
  } catch {
    throw new CliError(`${folder} already exists: name another --out, or remove it.`, ExitCode.USAGE, FETCH);
  }
  return folder;
};

/** Start a paid pack fetch (buying the credit first when the pool asks), wait for the pack, unpack it, and check it. */
export const dataFetch = async (deps: RunDeps, options: DataFetchOptions): Promise<Outcome> => {
  if (!STATE.test(options.state)) throw new CliError(`--state takes a two-letter US state, not ${options.state}.`, ExitCode.USAGE, FETCH);
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, FETCH, options.server);
  const { token } = await signedIn(deps, storeDir, server, FETCH);
  const credential = new Masker();
  credential.add(token);
  const listing = unwrap(FETCH, await datasets.get(apiClient(deps, { apiUrl: options.apiUrl, step: FETCH }), { listingId: options.listingId }));
  const body = { buyerKey: await buyerKeyOf(storeDir), state: options.state.toUpperCase() };
  const start = (): Promise<Reply> => ask(deps, FETCH, server, `/v1/packs/${encodeURIComponent(listing.priceRef)}/fetches`, { body, token, show: credential });
  let started = await start();
  let purchased = false;
  if (started.status === 402) {
    await buy(deps, options, storeDir, listing, paymentRequired(started));
    purchased = true;
    // A settled purchase can take a moment to count at the pool: ask again, a few times, before giving up.
    for (let attempt = 0; attempt <= START_RETRIES; attempt += 1) {
      started = await start();
      if (started.status !== 402) break;
      if (attempt < START_RETRIES) await deps.sleep(FIRST_WAIT_MS * 2 ** attempt);
    }
  }
  if (started.status === 202) await closePurchase(storeDir, listing.priceRef);
  const fetchId = started.status === 202 && isObject(started.body) ? textIn(started.body, 'fetchId') : undefined;
  if (fetchId !== undefined && !FETCH_ID.test(fetchId)) throw new CliError('The pool named a fetch id this command will not use in a path. Nothing was written.', ExitCode.UNEXPECTED, FETCH);
  const openId = started.status === 402 ? (await openPurchaseOf(storeDir, listing.priceRef))?.purchaseId : undefined;
  if (fetchId === undefined) throw started.status === 402 ? new CliError(`The pool still asks for payment after the purchase settled. Purchase ${openId ?? 'unknown'} is recorded in ${recordFile(storeDir, listing.priceRef)}: remove that file to buy again.`, ExitCode.CONFLICT, FETCH) : refusal(FETCH, started);
  let archive: Uint8Array | undefined;
  for (const wait of waits(FETCH_LIMIT_MS)) {
    const polled = await ask(deps, FETCH, server, `/v1/packs/fetches/${encodeURIComponent(fetchId)}`, { token, show: credential, binary: true });
    if (polled.status === 200 && polled.body instanceof Uint8Array) {
      archive = polled.body;
      break;
    }
    if (polled.status !== 202) throw refusal(FETCH, polled);
    await deps.sleep(wait);
  }
  if (archive === undefined) throw new CliError(`Fetch ${fetchId} is not ready yet: run the command again later; the pool keeps it for seven days.`, ExitCode.UNREACHABLE, FETCH);
  let files: TarFile[];
  try {
    files = readTar(archive);
  } catch (error) {
    if (error instanceof UnsafePack) throw new CliError(error.message, ExitCode.INVALID, FETCH, { code: 'pack_unsafe', title: error.message });
    throw error;
  }
  const folder = await freshFolder(options.out, fetchId);
  await writeFiles(folder, files);
  const problems = await checkPack(folder);
  if (problems.length > 0) {
    const title = `The pack failed validation (${String(problems.length)} found; first: ${problems[0] ?? ''}). It is kept at ${folder} for you to look at.`;
    throw new CliError(title, ExitCode.INVALID, FETCH, { code: 'pack_invalid', title }, { folder, problems });
  }
  const paid = purchased ? listing.amountUsd : undefined;
  return {
    document: { ok: true, fetchId, folder, files: files.length, purchased, ...(paid === undefined ? {} : { amountUsd: paid }) },
    text: `Fetched ${String(files.length)} files into ${folder}${paid === undefined ? '' : ` (bought one credit first, ${usd(paid)})`}.`,
  };
};
