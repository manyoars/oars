// `npm run fulfil -w packages/pool -- --lots <file> --terms <file> --owners <file> --index-key <file> [--server <url>] [--token-file <path>] [--work <dir>] [--local]`: the operator's builder for paid pack fetches (docs/pool.md, "Paid pack fetches").
// It reads the queue (`GET /v1/operator/fetches`), builds one pack per fetch under that buyer's key with `buildPack` (sample-pack.ts) from the lot's contents as they are now, checks it with `validate` (validate-pack.ts), puts it in `PACKS` as one tar archive under `packs/<fetchId>/`, and marks the fetch built.
// It takes no credit: the hand-over (`POST /v1/operator/fetches/:id/handover`) is a separate step, and this command never calls it or billing. A failed build marks the fetch failed, which frees the buyer's credit for another start.
// The buyer key is held in memory for the build only: it is passed to `buildPack` as a value, and never written to a file, an argument list, or a printed line.
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SessionsRuntime } from '../../cli/src/sessions/store.js';
import { archiveNames, END_OF_ARCHIVE, entries } from '../../pack-seller/src/tar.js';
import { fieldOf, staleObjections } from './deliver.js';
import type { Wrangler } from './erase-wrangler.js';
import { buildPack, heapMbOf, isText, PackError, type PackCounts, type PackOptions } from './sample-pack.js';

// The bundled command (fulfil.mjs) takes these from its one bundle, as sample-pack.mjs does.
export { heapRelaunch, runtimeOf } from './sample-pack.js';
import { lineOf, validate, type Result } from './validate-pack.js';

export const USAGE = [
  'Usage: fulfil --lots <file> --terms <file> --owners <file> --index-key <file> [--server <url>] [--token-file <path>] [--work <dir>] [--local] [--max-heap-mb <mb>]',
  '  Builds the pack of every queued paid fetch under its buyer key, checks it with validate-pack, puts it in the packs bucket under packs/<fetchId>/, and marks the fetch built.',
  '  A build, check, or upload that fails marks the fetch failed (no credit is taken, and no object is left). The hand-over that takes the credit is a separate step and is never called here.',
  '  --lots <file>        JSON list of {"lot": "<name>", "priceRefs": ["<priceRef>", ...]} with the build options of that lot: "deposits" (a folder pull-deposits wrote), "size", "seed", "minTurns", "stripThinking", "skeletonOnly", "olderThanDays", "excludeManifest", "excludeNames" (as sample-pack names them). A fetch whose price no entry lists stays queued',
  '  --terms, --owners, --index-key  the exclusion term list, the owners file, and the matching-index key, as sample-pack takes them (local files outside every repository)',
  '  --server <url>       the pool (default: OARS_POOL_URL, else https://pool.manyoars.com)',
  '  --token-file <path>  a file holding the pool\'s OPERATOR_TOKEN (default: the OARS_POOL_OPERATOR_TOKEN variable). There is no flag that takes the token itself: a value on a command line is logged',
  '  --work <dir>         where each pack is built before it is uploaded (default: the system temp folder), outside every git repository. Each build has a folder of its own there, removed when the fetch is done',
  '  --local              put the packs in the local wrangler state instead of the account\'s bucket (with --server pointing at wrangler dev)',
  '  --max-heap-mb <mb>   the V8 heap a build needs (default 8192), as sample-pack takes it',
  'The bucket is written through the operator\'s own wrangler login. Safe to run again: a fetch already built is not listed, and a fetch whose pack was uploaded but not marked is built and uploaded again over the same key.',
].join('\n');

/** The pool the CLI itself reaches when no server is named (`DEFAULT_POOL_URL`, packages/cli/src/sessions/pool-command.ts). */
export const DEFAULT_SERVER = 'https://pool.manyoars.com';
export const ENV_SERVER = 'OARS_POOL_URL';
export const ENV_TOKEN = 'OARS_POOL_OPERATOR_TOKEN';
/** The R2 bucket `wrangler.jsonc` binds as `PACKS`. */
export const PACKS_BUCKET = 'oars-pool-packs';
/** The one object of a fetch: a ustar archive of the pack folder with `manifest.jsonl` last, the format the pack seller's download already sends. */
export const PACK_NAME = 'pack.tar';

export const objectKeyOf = (fetchId: string): string => `packs/${fetchId}/${PACK_NAME}`;

/** The build options a lot fixes; the buyer key, the output folder, and the operator's three files come from the run. */
export type LotBuild = Pick<PackOptions, 'size' | 'seed' | 'minTurns' | 'deposits' | 'stripThinking' | 'skeletonOnly' | 'olderThanDays' | 'excludeManifest' | 'excludeNames'>;

/** One entry of the lots file: the prices that sell the lot, and how its pack is built. */
export interface Lot {
  lot: string;
  priceRefs: readonly string[];
  build: LotBuild;
}

const LOT_FIELDS = new Set(['lot', 'priceRefs', 'size', 'seed', 'minTurns', 'deposits', 'stripThinking', 'skeletonOnly', 'olderThanDays', 'excludeManifest', 'excludeNames']);

const isName = (value: unknown): value is string => isText(value) && value !== '';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const isDays = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isFlag = (value: unknown): value is boolean => typeof value === 'boolean';

/** The lots file. A malformed entry, an option this command does not know, or a price two entries list stops the run: a fetch is never built from a guess about which lot it bought. The defaults are `sample-pack`'s. */
export const parseLots = (text: string): Lot[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new PackError('The lots file is a JSON list.');
  const taken = new Set<string>();
  return parsed.map((entry: unknown, at): Lot => {
    const where = `Entry ${String(at + 1)} of the lots file`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new PackError(`${where} is not an object.`);
    const unknown = Object.keys(entry).find((field) => !LOT_FIELDS.has(field));
    if (unknown !== undefined) throw new PackError(`${where} has an option this command does not know: ${unknown}.`);
    const read = <T>(field: string, fits: (value: unknown) => value is T): T | undefined => {
      const value = fieldOf(entry, field);
      if (value === undefined) return undefined;
      if (!fits(value)) throw new PackError(`${where} has a bad value for ${field}.`);
      return value;
    };
    const lot = read('lot', isName);
    const priceRefs = read('priceRefs', (value): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isName));
    if (lot === undefined || priceRefs === undefined) throw new PackError(`${where} needs "lot" and "priceRefs": the lot's name and the prices that sell it.`);
    for (const ref of priceRefs) {
      if (taken.has(ref)) throw new PackError(`The price ${ref} is listed twice in the lots file.`);
      taken.add(ref);
    }
    return {
      lot,
      priceRefs,
      build: {
        size: read('size', isCount) ?? 25,
        seed: read('seed', isName) ?? '1',
        minTurns: read('minTurns', isCount) ?? 20,
        deposits: read('deposits', isName),
        stripThinking: read('stripThinking', isFlag),
        skeletonOnly: read('skeletonOnly', isFlag),
        olderThanDays: read('olderThanDays', isDays),
        excludeManifest: read('excludeManifest', isName),
        excludeNames: read('excludeNames', isName),
      },
    };
  });
};

/** A fetch as the queue lists it: only what the builder reads. */
export interface QueuedFetch {
  fetchId: string;
  priceRef: string;
  /** The lot the buyer paid for, as the pool recorded it at the start; null from a pool that does not send one (the price then names the lot). */
  lot: string | null;
  /** Null only for a row the pool should never list as queued; such a fetch is left alone. */
  buyerKey: string | null;
}

/** The three operator routes the builder calls. `handover` is not among them. */
export interface OperatorApi {
  queued: () => Promise<QueuedFetch[]>;
  /** Undefined when the pool marked the fetch built; otherwise the refusal (`409 not_queued`, `422 object_missing`, ...). */
  built: (fetchId: string, objectKey: string) => Promise<string | undefined>;
  failed: (fetchId: string) => Promise<void>;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** The operator routes over HTTP, bearer `OPERATOR_TOKEN`. An error names the route and the status, never the token. */
export const operatorApi = (server: string, token: string, fetcher: Fetcher = fetch): OperatorApi => {
  const base = `${server.replace(/\/+$/, '')}/v1/operator/fetches`;
  const call = (path: string, body?: object): Promise<Response> =>
    fetcher(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const refusalOf = async (response: Response): Promise<string> => {
    const code = fieldOf(await response.json().catch(() => undefined), 'error');
    return `${String(response.status)}${isText(code) ? ` ${code}` : ''}`;
  };
  return {
    // The whole queue: each page's `nextCursor` is followed until the pool names none.
    queued: async () => {
      const queue: QueuedFetch[] = [];
      for (let cursor: string | undefined; ; ) {
        const response = await call(cursor === undefined ? '?state=queued' : `?state=queued&cursor=${encodeURIComponent(cursor)}`);
        if (!response.ok) throw new Error(`The pool refused the queue read: ${await refusalOf(response)}.`);
        const body: unknown = await response.json();
        const fetches = fieldOf(body, 'fetches');
        if (!Array.isArray(fetches)) throw new Error('The pool answered the queue read with no fetches list.');
        queue.push(
          ...fetches.flatMap((row: unknown): QueuedFetch[] => {
            const [fetchId, priceRef, lot, buyerKey] = [fieldOf(row, 'fetchId'), fieldOf(row, 'priceRef'), fieldOf(row, 'lot'), fieldOf(row, 'buyerKey')];
            return isText(fetchId) && isText(priceRef) ? [{ fetchId, priceRef, lot: isText(lot) ? lot : null, buyerKey: isText(buyerKey) ? buyerKey : null }] : [];
          }),
        );
        const next = fieldOf(body, 'nextCursor');
        // A cursor that repeats would read the same page forever.
        if (!isText(next) || next === cursor) return queue;
        cursor = next;
      }
    },
    built: async (fetchId, objectKey) => {
      const response = await call(`/${fetchId}/built`, { objectKey });
      return response.ok ? undefined : refusalOf(response);
    },
    failed: async (fetchId) => {
      const response = await call(`/${fetchId}/failed`, {});
      if (!response.ok) throw new Error(`The pool refused the failed mark: ${await refusalOf(response)}.`);
    },
  };
};

/** The packs bucket: one object written from a file, and one removed. */
export interface PackBucket {
  put: (key: string, file: string) => Promise<void>;
  /** Removes the object; one that is not there is not an error. */
  remove: (key: string) => Promise<void>;
}

/** The bucket over the operator's own `wrangler` login, as the erasure store reaches R2 (`erase-wrangler.ts`): no R2 token is held anywhere. */
export const wranglerBucket = (wrangler: Wrangler, bucket: string, local: boolean): PackBucket => {
  const where = local ? '--local' : '--remote';
  return {
    put: async (key, file) => {
      await wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', 'application/x-tar', where]);
    },
    remove: async (key) => {
      await wrangler(['r2', 'object', 'delete', `${bucket}/${key}`, where]);
    },
  };
};

/** The operator's own files, the same three for every lot. */
export interface BuildInputs {
  terms: string;
  owners: string;
  indexKey: string;
}

export interface FulfilOptions {
  api: OperatorApi;
  bucket: PackBucket;
  lots: readonly Lot[];
  inputs: BuildInputs;
  /** Each build's folder is made under this one and removed when its fetch is done. */
  work: string;
  print: (text: string) => void;
  /** `buildPack` over the operator's store unless a test gives its own. */
  build: (options: PackOptions) => Promise<PackCounts>;
  /** `validate` (validate-pack.ts) unless a test gives its own. */
  check?: ((dir: string) => Promise<Result | undefined>) | undefined;
  vocabDir?: URL | undefined;
  now?: (() => number) | undefined;
}

/** What one run did with the fetches it read: `left` are still queued (no lot lists the price, the objections changed during the build, the pool or the bucket did not answer) and the next run takes them again; `gone` left the queue during their build (erased by the buyer, or handed over elsewhere), so there is nothing to take again and they do not fail the run. */
export interface Fulfilled {
  built: number;
  failed: number;
  left: number;
  gone: number;
}

type Verdict = keyof Fulfilled;

const FETCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

/** The pack folder as one archive file, the manifest last. */
const writeArchive = async (dir: string, file: string): Promise<void> => {
  const names = await archiveNames(dir);
  await pipeline(
    Readable.from(
      (async function* archive() {
        yield* entries(dir, names);
        yield END_OF_ARCHIVE;
      })(),
    ),
    createWriteStream(file),
  );
};

/** Builds, checks, uploads, and marks every queued fetch, one at a time, oldest first. One fetch's failure never stops the next. */
export const fulfil = async (options: FulfilOptions): Promise<Fulfilled> => {
  const { api, bucket, print } = options;
  const check = options.check ?? validate;
  const done: Fulfilled = { built: 0, failed: 0, left: 0, gone: 0 };

  /** Marks the fetch failed, after making sure `PACKS` holds nothing for it: this run's upload, or one an earlier run made before it stopped. A bucket or pool that does not answer leaves the fetch queued for the next run instead. */
  const fail = async (fetchId: string, why: string): Promise<Verdict> => {
    try {
      await bucket.remove(objectKeyOf(fetchId));
      await api.failed(fetchId);
    } catch (error) {
      print(`Fetch ${fetchId}: ${why} It could not be marked failed (${messageOf(error)}), so it stays queued.`);
      return 'left';
    }
    print(`Fetch ${fetchId} failed: ${why} Nothing was consumed, and no object is left.`);
    return 'failed';
  };

  const one = async ({ fetchId, priceRef, lot: named, buyerKey }: QueuedFetch): Promise<Verdict> => {
    // The id becomes a folder name and an object key, so one that is not a fetch id is never used as either.
    if (!FETCH_ID.test(fetchId) || buyerKey === null) {
      print(`A queued fetch has no usable id or no buyer key; it was left alone.`);
      return 'left';
    }
    // The lot the pool recorded is what the buyer paid for; the price names it only for a pool that sends none.
    const lot = named === null ? options.lots.find((entry) => entry.priceRefs.includes(priceRef)) : options.lots.find((entry) => entry.lot === named);
    if (lot === undefined) {
      print(named === null ? `Fetch ${fetchId}: no entry of the lots file lists the price ${priceRef}. It stays queued; add the price to its lot and run again.` : `Fetch ${fetchId}: no entry of the lots file is named ${named}, the lot this fetch bought. It stays queued; add the lot and run again.`);
      return 'left';
    }
    // Any text this fetch prints goes through here, so a message that quoted the key could not carry it to a log.
    const scrub = (text: string): string => text.replaceAll(buyerKey, '<buyer key>');
    const key = objectKeyOf(fetchId);
    const dir = await mkdtemp(join(options.work, 'oars-fulfil-'));
    try {
      // The folder is named for the fetch: `index.jsonl` beside the owners file then records each session's match id under the fetch id.
      const out = join(dir, fetchId);
      const archive = join(dir, PACK_NAME);
      try {
        const counts = await options.build({ ...lot.build, ...options.inputs, buyerKey, out, vocabDir: options.vocabDir, now: options.now });
        if (counts.emitted === 0) throw new PackError('The build wrote no session.');
        const record: unknown = JSON.parse(await readFile(join(out, 'pack.json'), 'utf8'));
        if (!isText(fieldOf(record, 'redactionVersion'))) throw new PackError('pack.json states no redactionVersion.');
        const violations = (await check(out))?.violations;
        if (violations === undefined) throw new PackError('validate-pack found no pack to check.');
        const [first] = violations;
        if (first !== undefined) throw new PackError(`validate-pack refused the pack (${String(violations.length)} found; first: ${lineOf(first)}).`);
        // An objection recorded while the pack was built was never applied to it (Art. 21(1)): the pack is dropped and the fetch built again by the next run, as `deliver` refuses such a pack.
        if ((await staleObjections(record, dirname(resolve(options.inputs.owners)))) !== undefined) {
          print(`Fetch ${fetchId}: the objections changed during the build. The pack was dropped and the fetch stays queued; run again.`);
          return 'left';
        }
        await writeArchive(out, archive);
      } catch (error) {
        return await fail(fetchId, scrub(`The build did not give a valid pack: ${messageOf(error)}`));
      }
      // A build can take hours, and an erasure fails the buyer's fetches meanwhile: a pack is uploaded only for a fetch the queue still lists.
      if (!(await api.queued()).some((fetch) => fetch.fetchId === fetchId)) {
        print(`Fetch ${fetchId} left the queue during the build (erased, or handed over elsewhere). The pack was dropped and nothing was uploaded.`);
        return 'gone';
      }
      try {
        await bucket.put(key, archive);
      } catch (error) {
        return await fail(fetchId, scrub(`The upload failed: ${messageOf(error)}`));
      }
      // A refusal here is not a failed build: the object stays, since the fetch may be built already (an answer lost on an earlier try), and the next run either does not list it or uploads over the same key and marks it.
      const refused = await api.built(fetchId, key).catch((error: unknown) => messageOf(error));
      if (refused !== undefined) {
        print(scrub(`Fetch ${fetchId}: the pack is at ${key}, and the pool did not mark it built (${refused}). Run again; if the fetch is failed, delete ${key}.`));
        return 'left';
      }
      print(`Fetch ${fetchId} built: lot ${lot.lot}, ${key}.`);
      return 'built';
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** One fetch's turn. A pool read or a build folder that fails (the queue recheck, `mkdtemp`) leaves that fetch queued and the run goes on to the next, as every other trouble with a single fetch does. */
  const turn = async (fetch: QueuedFetch): Promise<Verdict> => {
    try {
      return await one(fetch);
    } catch (error) {
      // Only the pool read and the build folder reach here, and neither one holds the buyer key.
      print(`Fetch ${fetch.fetchId}: ${messageOf(error)} It stays queued; run again.`);
      return 'left';
    }
  };

  // The queue is read in full, oldest first; a fetch this run already handled (and left queued) is not taken twice.
  const taken = new Set<string>();
  for (;;) {
    const page = (await api.queued()).filter((fetch) => !taken.has(fetch.fetchId));
    if (page.length === 0) return done;
    for (const fetch of page) {
      taken.add(fetch.fetchId);
      done[await turn(fetch)] += 1;
    }
  }
};

export interface Io {
  runtime: SessionsRuntime;
  print: (text: string) => void;
  wrangler: Wrangler;
  env: Readonly<NodeJS.ProcessEnv>;
  fetcher?: Fetcher | undefined;
  vocabDir?: URL | undefined;
  now?: (() => number) | undefined;
}

const VALUED = new Set(['--lots', '--terms', '--owners', '--index-key', '--server', '--token-file', '--work', '--max-heap-mb']);

/** Runs the command: 0 when every queued fetch ended built or left the queue itself, 1 when one failed or stays queued (or the pool could not be read), 2 on a usage or input error (nothing was read from the queue). */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const given = new Map<string, string>();
  let local = false;
  for (let at = 0; at < argv.length; at += 1) {
    const [flag, value] = [argv[at] ?? '', argv[at + 1]];
    if (flag === '--local') {
      local = true;
      continue;
    }
    if (!VALUED.has(flag) || value === undefined) {
      io.print(`Unknown or incomplete option: ${flag}\n${USAGE}`);
      return 2;
    }
    given.set(flag, value);
    at += 1;
  }
  const [lotsFile, terms, owners, indexKey] = ['--lots', '--terms', '--owners', '--index-key'].map((flag) => given.get(flag));
  if (lotsFile === undefined || terms === undefined || owners === undefined || indexKey === undefined) {
    io.print(`Missing a required option.\n${USAGE}`);
    return 2;
  }
  if (Number.isNaN(heapMbOf(argv))) {
    io.print('--max-heap-mb takes a whole number of 1 or more (megabytes).');
    return 2;
  }
  const tokenFile = given.get('--token-file');
  // A leading byte order mark and trailing whitespace are not part of the token, as for a buyer key file.
  const token = (tokenFile === undefined ? io.env[ENV_TOKEN] : await readFile(tokenFile, 'utf8').catch(() => undefined))?.replace(/^\uFEFF/, '').trim();
  if (token === undefined || token === '') {
    io.print(tokenFile === undefined ? `Give the operator token as --token-file <path> or in ${ENV_TOKEN}.` : `Cannot read a token from the --token-file ${tokenFile}.`);
    return 2;
  }
  let lots: Lot[];
  try {
    lots = parseLots(await readFile(lotsFile, 'utf8'));
  } catch (error) {
    io.print(error instanceof PackError ? error.message : `Cannot read the --lots file ${lotsFile} as JSON.`);
    return 2;
  }
  const server = given.get('--server') ?? io.env[ENV_SERVER] ?? DEFAULT_SERVER;
  try {
    const done = await fulfil({
      api: operatorApi(server, token, io.fetcher),
      bucket: wranglerBucket(io.wrangler, PACKS_BUCKET, local),
      lots,
      inputs: { terms, owners, indexKey },
      work: given.get('--work') ?? tmpdir(),
      print: io.print,
      build: (options) => buildPack(io.runtime, options),
      vocabDir: io.vocabDir,
      now: io.now,
    });
    io.print(`Fulfilled: ${String(done.built)} built, ${String(done.failed)} failed, ${String(done.left)} left queued, ${String(done.gone)} gone.`);
    return done.failed + done.left === 0 ? 0 : 1;
  } catch (error) {
    io.print(messageOf(error).replaceAll(token, '<token>'));
    return 1;
  }
};
