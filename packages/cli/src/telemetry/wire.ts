// Wire policing: what each deposit batch carried and what a send came to, so a field that is narrow (rarely present) or costly (many bytes nobody reads)
// shows up. Field names are only those of the register (`FIELD_ROWS`, the same list `oars pool outbox --explain` answers from); a value is never read
// past its size, and a name the register does not hold is not counted.
import { FIELD_ROWS } from '../sessions/pool-outbox.js';
import { HARNESSES, OTHER } from '../sessions/pool-wire.js';
import { emitEvent, type Emitter } from './emit.js';

/** One field across the batches of a pass: in how many it appeared, and the bytes of its values (a field that holds others counts them too). */
interface FieldTally {
  present: number;
  bytes: number;
}

interface HarnessTally {
  batches: number;
  bytes: number;
  fields: Map<string, FieldTally>;
}

/** The tally of one deposit pass, by the harness that wrote each batch. */
export type WireTally = Map<string, HarnessTally>;

export const newTally = (): WireTally => new Map();

const REGISTER: ReadonlySet<string> = new Set(Object.keys(FIELD_ROWS));

/** JSON.stringify answers `undefined` for a value it leaves out, which its signature does not say. */
const asText = (value: unknown): string | undefined => JSON.stringify(value);

/** The bytes of a value as JSON; a value JSON leaves out (`undefined`) is not on the wire and has none. */
const sizeOf = (value: unknown): number => {
  const text = asText(value);
  return text === undefined ? 0 : Buffer.byteLength(text);
};

const harnessOf = (batch: unknown): string => {
  const transcripts: unknown = typeof batch === 'object' && batch !== null ? Reflect.get(batch, 'transcripts') : undefined;
  const first: unknown = Array.isArray(transcripts) ? transcripts[0] : undefined;
  const harness: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'harness') : undefined;
  return typeof harness === 'string' && HARNESSES.some((known) => known === harness) ? harness : OTHER;
};

const walk = (value: unknown, seen: Map<string, number>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, seen);
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, entry] of Object.entries(value)) {
      if (REGISTER.has(name) && entry !== undefined) seen.set(name, (seen.get(name) ?? 0) + sizeOf(entry));
      walk(entry, seen);
    }
  }
};

const add = (tally: WireTally, batch: unknown): void => {
  const harness = harnessOf(batch);
  const entry = tally.get(harness) ?? { batches: 0, bytes: 0, fields: new Map<string, FieldTally>() };
  entry.batches += 1;
  entry.bytes += sizeOf(batch);
  const seen = new Map<string, number>();
  walk(batch, seen);
  for (const [name, bytes] of seen) {
    const field = entry.fields.get(name) ?? { present: 0, bytes: 0 };
    field.present += 1;
    field.bytes += bytes;
    entry.fields.set(name, field);
  }
  tally.set(harness, entry);
};

/** Adds one batch (the parsed skeleton, before it is written) to the tally. It never throws: a batch it cannot read (a cycle) adds nothing, and the deposit goes on. */
export const tallyBatch = (tally: WireTally, batch: unknown): void => {
  try {
    add(tally, batch);
  } catch {
    // Telemetry is never allowed to change what a command does.
  }
};

/** One `wire` event for each harness the pass built a batch for: the names, and beside them the batches that held each and the bytes it took. */
export const recordWire = (emitter: Emitter, tally: WireTally): void => {
  for (const [harness, entry] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
    const fields = [...entry.fields].sort(([a], [b]) => a.localeCompare(b));
    emitEvent(emitter, 'wire', {
      harness,
      batches: entry.batches,
      bytes: entry.bytes,
      fields: fields.map(([name]) => name),
      present: fields.map(([, field]) => field.present),
      fieldBytes: fields.map(([, field]) => field.bytes),
    });
  }
};

/** One send of one batch. `code` is the pool's own word for a refusal; the schema drops anything that is not a code. */
export const recordSend = (emitter: Emitter, send: { status: number; code?: string | undefined; bytes: number }): void => {
  emitEvent(emitter, 'wire-send', { sent: send.status === 201 ? 1 : 0, status: send.status, bytes: send.bytes, ...(send.code === undefined ? {} : { code: send.code }) });
};
