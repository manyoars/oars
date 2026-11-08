// The wire field register (docs/pool.md, "Wire field register"): one row per field a format 3 batch carries, naming its consumer, projection class, whether it re-derives from `raw/`, and its bytes on a
// fixture. "No row, no field" (direction conclusion 17.4) is this file: a field the client emits with no row fails here, and so does a row for a field the client no longer emits or whose bytes drifted.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BATCH_FIELDS, canonicalBytes, fieldsOf } from './pool-outbox.js';
import { parseSkeleton } from './pool-wire.js';
import { envelopeBytes, REGISTER_FIXTURE } from './pool-fixture.js';

const POOL_DOC = fileURLToPath(new URL('../../../../docs/pool.md', import.meta.url));

export interface RegisterRow {
  field: string;
  consumer: string;
  projection: string;
  rederives: string;
  bytes: number;
}

export const PROJECTION_CLASSES = ['clear', 'thresholded', 'hashed at ingest', 'raw tier'] as const;
export const REDERIVES = ['yes', 'partly', 'no'] as const;

/** The register's table: the rows between the "Wire field register" heading and the next heading, each `| \`field\` | consumer | class | re-derives | bytes |`. */
export const registerRows = (doc: string): RegisterRow[] => {
  const text = `\n${doc}`;
  const start = text.indexOf('\n## Wire field register');
  if (start === -1) return [];
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section
    .split('\n')
    .map((line) => /^\| `([A-Za-z]+)` \| (.+) \| (clear|thresholded|hashed at ingest|raw tier)(?: \([^|]*\))?(?:; [^|]*)? \| (yes|partly|no)(?:[^|]*) \| ([\d,]+) \|$/.exec(line))
    .flatMap((match) => (match === null ? [] : [{ field: match[1] ?? '', consumer: match[2] ?? '', projection: match[3] ?? '', rederives: match[4] ?? '', bytes: Number((match[5] ?? '').replaceAll(',', '')) }]));
};

/** The fields a batch emits with no row in a register. */
export const fieldsWithoutRow = (emitted: readonly string[], rows: readonly RegisterRow[]): string[] => emitted.filter((field) => !rows.some((row) => row.field === field));

/**
 * The bytes each field name holds in a batch's canonical JSON, summed over every place it occurs: a field's own `"name":` and a leaf value in full, and for an object or an array its braces and the commas
 * between its members, never the members themselves. The parts and `envelopeBytes` add up to the batch's canonical bytes.
 */
export const fieldBytes = (batch: object): Map<string, number> => {
  const held = new Map<string, number>();
  const add = (name: string, bytes: number): void => {
    held.set(name, (held.get(name) ?? 0) + bytes);
  };
  // `owner` is the field whose value this is; its structure (braces, brackets, commas) and any leaf inside an array of leaves are its own bytes, an object member's are the member's.
  const walk = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) {
      add(owner, 2 + Math.max(0, value.length - 1));
      for (const entry of value) walk(entry, owner);
    } else if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
      add(owner, 2 + Math.max(0, entries.length - 1));
      for (const [key, entry] of entries) {
        add(key, Buffer.byteLength(`${JSON.stringify(key)}:`, 'utf8'));
        walk(entry, key);
      }
    } else add(owner, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  };
  for (const [key, entry] of Object.entries(batch).filter(([, held]) => held !== undefined)) {
    add(key, Buffer.byteLength(`${JSON.stringify(key)}:`, 'utf8'));
    walk(entry, key);
  }
  return held;
};

const REGISTER = registerRows(readFileSync(POOL_DOC, 'utf8'));

describe('the wire field register', () => {
  it('the fixture is a batch the parser accepts and holds every field the client can emit', () => {
    expect(parseSkeleton(JSON.parse(canonicalBytes(REGISTER_FIXTURE)))).toMatchObject({ ok: true });
    expect(fieldsOf(canonicalBytes(REGISTER_FIXTURE))).toEqual([...BATCH_FIELDS]);
  });

  it('has a row for every field the client emits, and a row for nothing else', () => {
    const emitted = fieldsOf(canonicalBytes(REGISTER_FIXTURE));
    expect(fieldsWithoutRow(emitted, REGISTER)).toEqual([]);
    expect(REGISTER.map(({ field }) => field).sort()).toEqual(emitted);
    expect(new Set(REGISTER.map(({ field }) => field)).size).toBe(REGISTER.length);
  });

  it('fails on a field with no row, and on a section that is missing', () => {
    expect(fieldsWithoutRow(['day', 'brandNew'], REGISTER)).toEqual(['brandNew']);
    expect(fieldsWithoutRow(['day'], registerRows('# The pool\n\nno register here\n'))).toEqual(['day']);
    expect(registerRows('## Wire field register\n\n| `a` | b | clear | yes | 1 |\n\n## Next\n\n| `c` | d | clear | yes | 2 |\n').map(({ field }) => field)).toEqual(['a']);
    expect(registerRows('## Wire field register\n| `a` | b | clear | yes | 1 |').map(({ field }) => field)).toEqual(['a']);
  });

  it('holds a field to one of four classes: a bare hashed is no class, and a host reads hashed at ingest', () => {
    expect(registerRows('## Wire field register\n\n| `a` | b | hashed (by the client) | yes | 1 |\n')).toEqual([]);
    expect(registerRows('## Wire field register\n\n| `a` | b | clear-ish | yes | 1 |\n| `b` | b | clearly hashed | yes | 1 |\n| `c` | b | thresholdedX | yes | 1 |\n')).toEqual([]);
    expect(registerRows('## Wire field register\n\n| `a` | b | clear (bucket); thresholded (long tail) | yes | 1 |\n').map(({ projection }) => projection)).toEqual(['clear']);
    expect(registerRows('## Wire field register\n\n| `a` | b | hashed at ingest | yes | 1 |\n').map(({ projection }) => projection)).toEqual(['hashed at ingest']);
    expect(REGISTER.find(({ field }) => field === 'host')?.projection).toBe('hashed at ingest');
    for (const field of ['id', 'merkleRoot', 'timingPrint']) expect(REGISTER.find((row) => row.field === field)?.projection, field).toBe('clear');
  });

  it('names a consumer, a class, and whether it re-derives for every field', () => {
    for (const row of REGISTER) {
      expect(row.consumer.length, row.field).toBeGreaterThan(10);
      expect(PROJECTION_CLASSES, row.field).toContain(row.projection);
      expect(REDERIVES, row.field).toContain(row.rederives);
    }
  });

  it('states the bytes the fixture holds for each field, so a row cannot drift from the wire', () => {
    const measured = fieldBytes(REGISTER_FIXTURE);
    for (const row of REGISTER) expect(row.bytes, row.field).toBe(measured.get(row.field));
  });

  it('measures every byte of the batch, the envelope aside', () => {
    const total = [...fieldBytes(REGISTER_FIXTURE).values()].reduce((sum, bytes) => sum + bytes, 0);
    expect(total + envelopeBytes(REGISTER_FIXTURE)).toBe(Buffer.byteLength(canonicalBytes(REGISTER_FIXTURE), 'utf8'));
    expect(envelopeBytes(REGISTER_FIXTURE)).toBe(9);
    expect(Buffer.byteLength(canonicalBytes(REGISTER_FIXTURE), 'utf8')).toBe(3_678);
    expect(fieldBytes({ a: [1, 2], b: { c: 'x' }, d: undefined }).get('a')).toBe(4 + 5);
    expect(fieldBytes({ a: [1, 2], b: { c: 'x' }, d: undefined }).get('b')).toBe(4 + 2);
    expect(fieldBytes({ a: [1, 2], b: { c: 'x' }, d: undefined }).get('c')).toBe(7);
  });
});
