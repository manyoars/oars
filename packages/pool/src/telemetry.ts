// `POST /v1/telemetry`: product telemetry from the CLI, a channel beside the session wire. It is not a deposit, so it needs no covenant and no sign-in. A batch is kept whole in R2, which is the
// record (for `RETENTION_DAYS`, then the nightly sweep drops it: `retention.ts`), and its events are written to Workers Analytics Engine, which is what reads come from. Analytics Engine keeps three months, and it is the index, not the record.
// Nothing here joins a batch to a deposit or an account: no address, user agent, or Authorization header is read, so a bearer a client sends is ignored and never stored (census S23).
import { answer, fieldOf, notConfigured, refuse, type Env } from './http.js';

/** Analytics Engine takes at most this many data points in one invocation. */
export const MAX_BATCH_EVENTS = 250;

/**
 * What one request can put in the record, sized from what the CLI sends (`packages/cli/src/telemetry/send.ts`: at most `MAX_BATCH_EVENTS` events a request). The two event types whose size depends on a list are bounded by the schema
 * (`packages/cli/src/telemetry/schema.ts`): a `command` holds at most 4 path and 40 flag tokens of 32 characters, 1,804 bytes as the spool line, with its `ci` word and `cardLine` arm, and a `wire` event holds the register's field list and nothing else (`wire.ts:1-3`, `FIELD_ROWS` in
 * `sessions/pool-outbox.ts`), 2,254 bytes with a seven-digit byte count on every field. Both are measured from the CLI's own writers in `packages/cli/src/telemetry/wire.test.ts` ("the size of the largest telemetry events"). Every other type is
 * numbers and closed words, and a typical command event is about 0.3 KB, so a usual batch is about 75 KB. The worst a CLI can send is 11 `wire` events (one per harness) and 239 maximal commands, 445 KiB, so the cap is 512 KiB: it admits that,
 * and is half the 1 MiB it replaces. The route takes no credential, so this is what bounds the bytes one request can write.
 */
export const MAX_BATCH_BYTES = 512 * 1024;

/**
 * How many batches one install id may send on one UTC day. The CLI sends once a day (`dueForSend`), one request per 250 events; a full spool (two files of 1 MiB, `SPOOL_CAP_BYTES` in `packages/cli/src/telemetry/spool.ts`) holds about 7,000
 * events at 0.3 KB, which is 28 batches, so a full spool can pass 24 batches, and the 429 leaves the rest in the spool for the next day's send. The id is a claim anyone can make up, so this bounds an
 * honest install gone wrong, not a determined sender: the WAF rate rule (docs/pool.md, deploy step 6) is the bound on that.
 */
export const MAX_BATCHES_PER_INSTALL_DAY = 24;

const DAY_MS = 86_400_000;

const MAX_TYPE_LENGTH = 64;
/** A blob is cut here when it is indexed; the record keeps the full text. */
const MAX_BLOB_LENGTH = 128;
/** The install id the CLI keeps: a random UUID. The rollup reads batches from the record with the same rule. */
export const INSTALL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One Analytics Engine data point. */
export interface DataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** The part of an R2 bucket this route uses, so the code does not take the ambient Workers types, which clash with Node's. */
export interface Bucket {
  put: (key: string, value: string) => Promise<unknown>;
}

/** The part of an Analytics Engine dataset binding this route uses. */
export interface Dataset {
  writeDataPoint: (point: DataPoint) => void;
}

/** Both are set by the deploy. An unset bucket refuses the route (nothing would be kept); an unset dataset only means nothing is indexed. */
export interface TelemetryEnv {
  TELEMETRY?: Bucket;
  TELEMETRY_EVENTS?: Dataset;
}

/** Only `application/json`: a page can send a `text/plain`, form, or multipart POST cross-origin with no preflight, and this route sets no CORS header, so a browser can send nothing else here. */
const JSON_TYPE = /^application\/json\s*(;|$)/i;

const shape = (message: string, field: string): Response => refuse(400, 'invalid_telemetry', message, field);

/** A plain object: not null, and not a list. */
const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value.slice(0, MAX_BLOB_LENGTH) : '');
const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** The strings of a list, joined; anything else in it is skipped. */
const joined = (value: unknown, separator: string): string =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').join(separator).slice(0, MAX_BLOB_LENGTH) : '';

/**
 * The data point for one event. The layout is fixed, since a read names columns by position (docs/pool.md):
 * index1 = install id; blob1..7 = type, cli, os, command path, error class, account (always empty since t956: the route reads no credential), flag names;
 * double1..4 = schema version, event time (epoch ms), duration (ms), exit code. A field an event does not carry is an empty blob or 0, and a type this server has never seen indexes its envelope only.
 */
const pointOf = (install: string, account: string, event: object): DataPoint => {
  const data = fieldOf(event, 'data');
  const at = Date.parse(textOf(fieldOf(event, 'at')));
  return {
    indexes: [install],
    blobs: [textOf(fieldOf(event, 'type')), textOf(fieldOf(event, 'cli')), textOf(fieldOf(event, 'os')), joined(fieldOf(data, 'path'), ' '), textOf(fieldOf(data, 'errorClass')), account, joined(fieldOf(data, 'flags'), ',')],
    doubles: [numberOf(fieldOf(event, 'v')), Number.isNaN(at) ? 0 : at, numberOf(fieldOf(data, 'durationMs')), numberOf(fieldOf(data, 'exitCode'))],
  };
};

/** The events of a batch that the shape allows, or the refusal that names the first field that does not. */
const eventsOf = (body: unknown): { install: string; events: object[] } | Response => {
  if (!isRecord(body)) return shape('The body is not a JSON object.', 'body');
  const install = fieldOf(body, 'install');
  if (typeof install !== 'string' || !INSTALL.test(install)) return shape('install is the random UUID the CLI keeps for this install.', 'install');
  const events = fieldOf(body, 'events');
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH_EVENTS) return shape(`events is a list of 1 to ${String(MAX_BATCH_EVENTS)} events.`, 'events');
  const checked: object[] = [];
  for (const [at, event] of events.entries()) {
    if (!isRecord(event)) return shape('An event is a JSON object.', `events[${String(at)}]`);
    const type = fieldOf(event, 'type');
    if (typeof type !== 'string' || type === '' || type.length > MAX_TYPE_LENGTH) return shape(`An event names its type, 1 to ${String(MAX_TYPE_LENGTH)} characters.`, `events[${String(at)}].type`);
    checked.push(event);
  }
  return { install, events: checked };
};

/** Writes the batch's data points; the record is already kept, so a dataset that fails costs the index, never the batch. */
const index = (dataset: Dataset | undefined, points: readonly DataPoint[]): boolean => {
  if (dataset === undefined) return false;
  try {
    for (const point of points) dataset.writeDataPoint(point);
    return true;
  } catch {
    return false;
  }
};

/** Counts this batch against the install's day and answers the count; a statement that answers none is a fault, never a pass. */
const spend = async (env: Env, install: string, day: string): Promise<number> => {
  const row = await env.DB.prepare('INSERT INTO telemetry_quota (install, day, count) VALUES (?, ?, 1) ON CONFLICT (install, day) DO UPDATE SET count = count + 1 RETURNING count').bind(install, day).first();
  const count = fieldOf(row, 'count');
  if (typeof count !== 'number') throw new Error('The quota statement answered no count.');
  return count;
};

export const telemetry = async (request: Request, env: Env & TelemetryEnv, now: () => number): Promise<Response> => {
  const bucket = env.TELEMETRY;
  if (bucket === undefined) return notConfigured('TELEMETRY');
  if (!JSON_TYPE.test(request.headers.get('content-type') ?? '')) return refuse(415, 'unsupported_media_type', 'A telemetry batch is application/json.');
  const tooLarge = (): Response => refuse(413, 'too_large', `A telemetry batch holds at most ${String(MAX_BATCH_BYTES)} bytes.`);
  if (Number(request.headers.get('content-length')) > MAX_BATCH_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BATCH_BYTES) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const checked = eventsOf(body);
  if (checked instanceof Response) return checked;
  const received = new Date(now()).toISOString();
  // Counted before the batch is kept, and a fault in the count refuses the batch: a bound that opens when its store fails is no bound. The client's resend is the retry.
  try {
    if ((await spend(env, checked.install, received.slice(0, 10))) > MAX_BATCHES_PER_INSTALL_DAY) {
      const retryAfter = Math.max(1, Math.ceil((Date.parse(`${received.slice(0, 10)}T00:00:00Z`) + DAY_MS - now()) / 1000));
      return refuse(429, 'quota_exceeded', `An install sends at most ${String(MAX_BATCHES_PER_INSTALL_DAY)} telemetry batches a UTC day.`, undefined, { 'retry-after': String(retryAfter) });
    }
  } catch {
    return refuse(503, 'telemetry_unavailable', 'The batch could not be counted. Send it again.');
  }
  const key = `telemetry/${received.slice(0, 10)}/${crypto.randomUUID()}.json`;
  try {
    // The batch as it came, beside when it arrived. Nothing about the connection or a credential is read, so none of it can be kept.
    await bucket.put(key, JSON.stringify({ received, batch: body }));
  } catch {
    // Nothing is indexed on this path, so the resend the client makes does not count the batch twice. The slot goes back too, or each resend during an R2 outage would spend one of the install's day; a refund that fails costs the slot, no more.
    try {
      await env.DB.prepare('UPDATE telemetry_quota SET count = count - 1 WHERE install = ? AND day = ?').bind(checked.install, received.slice(0, 10)).run();
    } catch {
      // Best effort: the 503 below is the answer either way.
    }
    return refuse(503, 'telemetry_unavailable', 'The batch could not be kept. Send it again.');
  }
  const indexed = index(
    env.TELEMETRY_EVENTS,
    checked.events.map((event) => pointOf(checked.install, '', event)),
  );
  return answer(201, { ok: true, kept: checked.events.length, indexed });
};
