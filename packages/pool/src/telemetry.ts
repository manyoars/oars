// `POST /v1/telemetry`: product telemetry from the CLI, a channel beside the session wire. It is not a deposit, so it needs no covenant and no sign-in. A batch is kept whole in R2, which is the
// record, and its events are written to Workers Analytics Engine, which is what reads come from. Analytics Engine keeps three months, so it is the index and never the only copy. Nothing here
// joins a batch to a deposit, and no address or user agent is read.
import { accountOf } from './identity.js';
import { answer, fieldOf, notConfigured, refuse, type Env } from './http.js';

/** Analytics Engine takes at most this many data points in one invocation. */
export const MAX_BATCH_EVENTS = 250;

/** A batch is a few hundred bytes an event, so this is far past an honest one; the route takes no credential, so it bounds what one request can put in the record. */
export const MAX_BATCH_BYTES = 1024 * 1024;

const MAX_TYPE_LENGTH = 64;
/** A blob is cut here when it is indexed; the record keeps the full text. */
const MAX_BLOB_LENGTH = 128;
const INSTALL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * index1 = install id; blob1..7 = type, cli, os, command path, error class, account, flag names;
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

export const telemetry = async (request: Request, env: Env & TelemetryEnv, now: () => number): Promise<Response> => {
  const bucket = env.TELEMETRY;
  if (bucket === undefined) return notConfigured('TELEMETRY');
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
  // A credential names the account; one the pool does not know is no credential, and the batch is kept without it.
  // The same holds when the database fails while the credential is read: usage data is never refused for want of an account.
  const account = request.headers.has('authorization') ? await accountOf(request, env).catch(() => undefined) : undefined;
  const received = new Date(now()).toISOString();
  const key = `telemetry/${received.slice(0, 10)}/${crypto.randomUUID()}.json`;
  try {
    // The batch as it came, beside when it arrived and who sent it. Nothing about the connection is read, so none of it can be kept.
    await bucket.put(key, JSON.stringify({ received, ...(account === undefined ? {} : { account }), batch: body }));
  } catch {
    // Nothing is indexed on this path, so the resend the client makes does not count the batch twice.
    return refuse(503, 'telemetry_unavailable', 'The batch could not be kept. Send it again.');
  }
  const indexed = index(
    env.TELEMETRY_EVENTS,
    checked.events.map((event) => pointOf(checked.install, account ?? '', event)),
  );
  return answer(201, { ok: true, kept: checked.events.length, indexed });
};
