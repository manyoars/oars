import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { deliver, fieldOf, staleObjections } from '../../pool/scripts/deliver.js';
import { buildPack, insideRepository, isAbsent, isText, keyIdOf, PackError, type PackCounts, type PackOptions } from '../../pool/scripts/sample-pack.js';
import { runtimeOf } from '../../pool/scripts/sample-pack.js';
import { ConfigError } from './config.js';
import { priceInputFor, PricingError } from './pricing.js';
import { BUILD_FAILED, type Outcome } from './refusal.js';
import type { OfferLedger, OfferRecord, PackListing } from './routes.js';

export const ENV_PACKS_DIR = 'OARS_SELLER_PACKS_DIR';
export const ENV_TERMS_FILE = 'OARS_SELLER_TERMS_FILE';
export const ENV_OWNERS_FILE = 'OARS_SELLER_OWNERS_FILE';
export const ENV_INDEX_KEY_FILE = 'OARS_SELLER_INDEX_KEY_FILE';
export const ENV_STORE_DIR = 'OARS_SELLER_STORE_DIR';
export const ENV_PROJECTS_DIR = 'OARS_SELLER_PROJECTS_DIR';
export const LISTING_FILE = 'listing.json';
export const PREVIEW_DIR = 'preview';
export const BUILDS_DIR = 'builds';
export const OFFERS_FILE = 'offers.jsonl';

/** The operator-local inputs a build needs. Every one is refused at start when it sits inside a git repository: none of them is ever committed. */
export interface PackInputs {
  /** One folder per pack: `<packId>/listing.json` and `<packId>/preview/` (a pack the operator built for the page); per-buyer builds go under `builds/`. */
  packsDir: string;
  terms: string;
  owners: string;
  indexKey: string;
  /** `<config>/oars/sessions`, the session store copy. */
  storeDir: string;
  /** The transcripts root (`~/.claude/projects`). */
  projectsDir: string;
}

const VARIABLES = [
  ['packsDir', ENV_PACKS_DIR],
  ['terms', ENV_TERMS_FILE],
  ['owners', ENV_OWNERS_FILE],
  ['indexKey', ENV_INDEX_KEY_FILE],
  ['storeDir', ENV_STORE_DIR],
  ['projectsDir', ENV_PROJECTS_DIR],
] as const;

/** Reads the six paths; a missing one, or one inside a git repository, is a `ConfigError` of one line that names the variable. */
export const loadPackInputs = (env: Readonly<NodeJS.ProcessEnv>): PackInputs => {
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === '') throw new ConfigError(`${name} is not set.`);
    const path = resolve(value);
    if (insideRepository(path)) throw new ConfigError(`${name} is inside a git repository: keep it on this machine, outside every repository.`);
    return path;
  };
  // The owners file's folder also holds deliveries.jsonl, offers.jsonl, and index.jsonl; `insideRepository` walks up through that folder from the file itself.
  const [packsDir, terms, owners, indexKey, storeDir, projectsDir] = VARIABLES.map(([, name]) => read(name));
  return { packsDir: packsDir ?? '', terms: terms ?? '', owners: owners ?? '', indexKey: indexKey ?? '', storeDir: storeDir ?? '', projectsDir: projectsDir ?? '' };
};

/** The four terms fields of one manifest row, which the pack page shows before any offer. The row's match id is keyed to the operator's own key, so it is not shown. */
export interface RowTerms {
  sourceLicense: unknown;
  harnessTerms: unknown;
  permittedUses: unknown;
  training: unknown;
}

/** What the pack page shows: the listing, `pack.json` (without the operator's key id and objections hash), the census, the data card, and each row's terms. */
export interface PackPage extends PackListing {
  pack: object;
  census: unknown;
  /** The README data card, when the preview was built `skeletonOnly`; otherwise null. */
  card: string | null;
  terms: RowTerms[];
}

const jsonLines = (text: string): unknown[] =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): unknown => JSON.parse(line));

const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
};

const summaryOf = (record: unknown): object => {
  const shown: { [name: string]: unknown } = {};
  if (typeof record === 'object' && record !== null) {
    for (const [name, value] of Object.entries(record)) if (name !== 'keyId' && name !== 'objections') shown[name] = value;
  }
  return shown;
};

/** `<packId>/listing.json`: the title and the build options of one pack. */
export interface Listing {
  title: string;
  size?: number;
  seed?: string;
  minTurns?: number;
  stripThinking?: boolean;
  skeletonOnly?: boolean;
  olderThanDays?: number;
}

const parseListing = (packId: string, value: unknown): Listing => {
  const bad = (what: string): ConfigError => new ConfigError(`${LISTING_FILE} of pack ${packId} ${what}.`);
  const title = fieldOf(value, 'title');
  if (!isText(title) || title.trim() === '') throw bad('has no title');
  const listing: Listing = { title: title.trim() };
  for (const name of ['size', 'minTurns', 'olderThanDays'] as const) {
    const got = fieldOf(value, name);
    if (got === undefined) continue;
    if (typeof got !== 'number' || !Number.isInteger(got) || got < 1) throw bad(`has a ${name} that is not a positive whole number`);
    listing[name] = got;
  }
  const seed = fieldOf(value, 'seed');
  if (seed !== undefined) {
    if (!isText(seed)) throw bad('has a seed that is not text');
    listing.seed = seed;
  }
  for (const name of ['stripThinking', 'skeletonOnly'] as const) {
    const got = fieldOf(value, name);
    if (got === undefined) continue;
    if (typeof got !== 'boolean') throw bad(`has a ${name} that is not true or false`);
    listing[name] = got;
  }
  return listing;
};

/** What the download route needs of the store: a build under the buyer's key that is current against the objections, and the delivery record. */
export interface PackSource {
  /** Builds (or reuses a build that is current) under `buyerKey`; the key is held for this call only. A refusal is the seller's own line, never the builder's text. */
  prepare: (packId: string, buyerKey: string) => Promise<Outcome<string>>;
  /** True while the build in `dir` is still current against the objections; false once an objection has landed since it was built. */
  check: (dir: string) => Promise<boolean>;
  /** Appends the delivery rows (`deliver`'s record, with the offer's recipient and license). */
  record: (dir: string, buyerKey: string, offer: OfferRecord) => Promise<void>;
}

export type Builder = (options: PackOptions) => Promise<PackCounts>;

export interface PackStore extends PackSource {
  catalog: { list: () => PackPage[]; find: (packId: string) => PackPage | undefined };
  ledger: OfferLedger;
  /** The pack ids and titles, for the price command. */
  packs: () => { packId: string; title: string }[];
}

export interface StoreOptions {
  /** Replaces `buildPack` bound to the store copy; a test injects its own only where a build is not the thing under test. */
  build?: Builder;
}

/** The CLI's vocabulary folder, found from this package's place in the repository (a bundled seller has no copy of its own). */
const VOCAB = new URL('../../cli/vocab/', import.meta.url);

const loadPages = async (inputs: PackInputs): Promise<{ pages: Map<string, PackPage>; listings: Map<string, Listing> }> => {
  const pages = new Map<string, PackPage>();
  const listings = new Map<string, Listing>();
  const folders = await readdir(inputs.packsDir, { withFileTypes: true }).catch(() => {
    throw new ConfigError(`${ENV_PACKS_DIR} names a folder that cannot be read.`);
  });
  for (const entry of folders.filter((item) => item.isDirectory() && item.name !== BUILDS_DIR)) {
    const packId = entry.name;
    const listingText = await readText(join(inputs.packsDir, packId, LISTING_FILE));
    if (listingText === undefined) continue;
    const listing = parseListing(packId, JSON.parse(listingText));
    let priceRef: string;
    try {
      priceRef = priceInputFor({ packId, title: listing.title }, '1').priceRef;
    } catch (error) {
      if (error instanceof PricingError) throw new ConfigError(`Pack ${packId}: ${error.message}`);
      throw error;
    }
    const preview = join(inputs.packsDir, packId, PREVIEW_DIR);
    const [packText, censusText, manifestText, card] = await Promise.all(['pack.json', 'census.json', 'manifest.jsonl', 'README.md'].map((name) => readText(join(preview, name))));
    if (packText === undefined || censusText === undefined || manifestText === undefined) throw new ConfigError(`Pack ${packId} has no built preview (pack.json, census.json, manifest.jsonl).`);
    const terms = jsonLines(manifestText).map(
      (row): RowTerms => ({
        sourceLicense: fieldOf(row, 'sourceLicense'),
        harnessTerms: fieldOf(row, 'harnessTerms'),
        permittedUses: fieldOf(row, 'permittedUses'),
        training: fieldOf(row, 'training'),
      }),
    );
    listings.set(packId, listing);
    pages.set(packId, { packId, priceRef, title: listing.title, pack: summaryOf(JSON.parse(packText)), census: JSON.parse(censusText), card: card ?? null, terms });
  }
  return { pages, listings };
};

/** The offer record on disk, one JSON line per offer, beside `deliveries.jsonl`: it survives a restart. It holds customer refs, so it is never logged and never inside a repository. */
export const fileLedger = (file: string): OfferLedger => ({
  record: (entry) => {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  },
  find: (customerRef) => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
    for (const row of jsonLines(text).reverse()) {
      const [ref, packId, recipientLegalName, licenseVersion, recordedAt] = ['customerRef', 'packId', 'recipientLegalName', 'licenseVersion', 'recordedAt'].map((name) => fieldOf(row, name));
      if (ref === customerRef && isText(packId) && isText(recipientLegalName) && isText(licenseVersion) && typeof recordedAt === 'number') {
        return { customerRef, packId, recipientLegalName, licenseVersion, recordedAt };
      }
    }
    return undefined;
  },
});

export const openPackStore = async (inputs: PackInputs, options: StoreOptions = {}): Promise<PackStore> => {
  const runtime = { ...runtimeOf({}), storeDir: inputs.storeDir, projectsRoot: inputs.projectsDir };
  const build: Builder = options.build ?? ((buildOptions) => buildPack(runtime, buildOptions));
  const ownersDir = dirname(inputs.owners);
  const { pages, listings } = await loadPages(inputs);

  const current = async (dir: string): Promise<boolean> => {
    const text = await readText(join(dir, 'pack.json'));
    return text !== undefined && (await staleObjections(JSON.parse(text), ownersDir)) === undefined;
  };
  const make = async (listing: Listing, buyerKey: string, dir: string): Promise<Outcome<string>> => {
    try {
      // A build left by an earlier run is reused only while pack.json's objections hash is current (Art. 21(1)); otherwise it is rebuilt.
      if (await current(dir)) return { ok: true, value: dir };
      await rm(dir, { recursive: true, force: true });
      await mkdir(dirname(dir), { recursive: true });
      const counts = await build({
        terms: inputs.terms,
        owners: inputs.owners,
        indexKey: inputs.indexKey,
        buyerKey,
        out: dir,
        size: listing.size ?? 25,
        seed: listing.seed ?? '1',
        minTurns: listing.minTurns ?? 20,
        stripThinking: listing.stripThinking,
        skeletonOnly: listing.skeletonOnly,
        olderThanDays: listing.olderThanDays,
        vocabDir: VOCAB,
      });
      if (counts.emitted > 0) return { ok: true, value: dir };
      await rm(dir, { recursive: true, force: true });
      return { ok: false, refusal: BUILD_FAILED };
    } catch (error) {
      // The builder's own message can name a path or a term; the buyer gets the seller's line only.
      if (error instanceof PackError || error instanceof SyntaxError || (error instanceof Error && 'code' in error)) return { ok: false, refusal: BUILD_FAILED };
      throw error;
    }
  };

  const inFlight = new Map<string, Promise<Outcome<string>>>();
  return {
    catalog: { list: () => [...pages.values()], find: (packId) => pages.get(packId) },
    packs: () => [...pages.values()].map(({ packId, title }) => ({ packId, title })),
    ledger: fileLedger(join(ownersDir, OFFERS_FILE)),
    prepare: (packId, buyerKey) => {
      const listing = listings.get(packId);
      if (listing === undefined) return Promise.resolve({ ok: false, refusal: BUILD_FAILED });
      const dir = join(inputs.packsDir, BUILDS_DIR, `${packId}-${keyIdOf(buyerKey)}`);
      // One build per (pack, key) at a time: a second request for the same buyer waits for the first rather than racing it on one folder.
      const running = inFlight.get(dir) ?? make(listing, buyerKey, dir).finally(() => inFlight.delete(dir));
      inFlight.set(dir, running);
      return running;
    },
    check: current,
    record: async (dir, buyerKey, offer) => {
      await deliver({ pack: dir, recipient: offer.recipientLegalName, license: offer.licenseVersion, buyerKey, owners: inputs.owners });
    },
  };
};
