// Wire policing: for each deposit pass, which fields of the register each harness's batches held and how many bytes each took, and what the pool answered a send.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIELD_ROWS } from '../sessions/pool-outbox.js';
import { emitEvent } from './emit.js';
import { spoolEvents, type SpoolEvent } from './read-events.js';
import { readSpool } from './spool.js';
import { newTally, recordSend, recordWire, tallyBatch } from './wire.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const emitter = (): { dir: string; emitter: Parameters<typeof recordWire>[0] } => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-wire-'));
  roots.push(appData);
  const dir = join(appData, 'oars', 'telemetry');
  return { dir, emitter: { env: { APPDATA: appData }, telemetry: { dir, platform: 'linux' }, version: '1.2.3', now: () => Date.parse('2026-11-07T00:00:00Z') } };
};

const events = (dir: string): SpoolEvent[] => spoolEvents(dir);

// Two batches by hand. Field names are the register's; the values are invented.
const FIRST = { format: 3, id: 'abcd', deltas: [], transcripts: [{ harness: 'claude-code', steps: [{ action: 'file.read' }, { action: 'shell.exec' }] }] };
const SECOND = { format: 3, id: 'ef01', deltas: [], transcripts: [{ harness: 'claude-code', steps: [{ action: 'file.edit' }] }] };
const OTHER_HARNESS = { format: 3, id: '2345', deltas: [], transcripts: [{ harness: 'cursor', steps: [] }] };

describe('the wire tally', () => {
  it('counts each field once per batch and its bytes every time, by harness, against a hand count', () => {
    const tally = newTally();
    tallyBatch(tally, FIRST);
    tallyBatch(tally, SECOND);
    tallyBatch(tally, OTHER_HARNESS);
    const claude = tally.get('claude-code');
    expect(claude?.batches).toBe(2);
    // `action` is in both batches (present 2) and its three values are 11 + 12 + 11 bytes as JSON strings: "file.read", "shell.exec", "file.edit".
    expect(claude?.fields.get('action')).toEqual({ present: 2, bytes: 11 + 12 + 11 });
    expect(claude?.fields.get('id')).toEqual({ present: 2, bytes: 6 + 6 });
    expect(claude?.fields.get('format')).toEqual({ present: 2, bytes: 2 });
    // `steps` holds each step whole, so its bytes include the fields inside it.
    expect(claude?.fields.get('steps')).toEqual({ present: 2, bytes: JSON.stringify(FIRST.transcripts[0]?.steps).length + JSON.stringify(SECOND.transcripts[0]?.steps).length });
    expect(tally.get('cursor')?.batches).toBe(1);
    expect(tally.get('cursor')?.fields.get('action')).toBeUndefined();
  });

  it('counts only names the register holds, and a batch of no known harness as other', () => {
    const tally = newTally();
    tallyBatch(tally, { transcripts: [{ harness: '/home/someone/x', unknownField: 'secret-project', steps: [] }] });
    const other = tally.get('other');
    expect([...(other?.fields.keys() ?? [])].sort()).toEqual(['harness', 'steps', 'transcripts']);
    expect([...(other?.fields.keys() ?? [])].every((name) => name in FIELD_ROWS)).toBe(true);
    tallyBatch(tally, 'not an object');
    tallyBatch(tally, null);
    expect(tally.get('other')?.batches).toBe(3);
    // A key whose value JSON leaves out is not on the wire, and a batch that cannot be walked adds nothing and does not throw.
    const quiet = newTally();
    tallyBatch(quiet, { id: undefined, format: 3 });
    expect([...(quiet.get('other')?.fields.keys() ?? [])]).toEqual(['format']);
    const cycle: { [key: string]: unknown } = { format: 3 };
    cycle.id = cycle;
    expect(() => {
      tallyBatch(quiet, cycle);
    }).not.toThrow();
  });
});

describe('recording the tally and the send', () => {
  it('writes one wire event for each harness, names and numbers side by side, and no value', () => {
    const { dir, emitter: made } = emitter();
    const tally = newTally();
    tallyBatch(tally, FIRST);
    tallyBatch(tally, OTHER_HARNESS);
    recordWire(made, tally);
    const written = events(dir);
    expect(written.map((event) => event.type)).toEqual(['wire', 'wire']);
    const claude = written.find((event) => event.data.harness === 'claude-code');
    const listed = claude?.data.fields;
    if (!Array.isArray(listed)) throw new Error('the wire event holds no field list');
    const fields = listed.map(String);
    expect(fields).toEqual([...fields].sort());
    expect(claude?.data.present).toHaveLength(fields.length);
    expect(claude?.data.fieldBytes).toHaveLength(fields.length);
    expect(claude?.data.batches).toBe(1);
    const bytes = claude?.data.fieldBytes;
    expect(Array.isArray(bytes) ? bytes[fields.indexOf('action')] : undefined).toBe(11 + 12);
    expect(readSpool(dir).join('')).not.toContain('file.read');
    expect(readSpool(dir).join('')).not.toContain('abcd');
  });

  it('records a send: taken, or refused with the pool\'s code, and the bytes', () => {
    const { dir, emitter: made } = emitter();
    recordSend(made, { status: 201, bytes: 5000 });
    recordSend(made, { status: 429, code: 'rate_limited', bytes: 5000 });
    recordSend(made, { status: 400, code: '/home/someone/secret-project', bytes: 10 });
    const written = events(dir).map((event) => event.data);
    expect(written[0]).toEqual({ sent: 1, status: 201, bytes: 5000 });
    expect(written[1]).toEqual({ sent: 0, status: 429, code: 'rate_limited', bytes: 5000 });
    // A code that is not a code (a path, a sentence) is dropped, not stored.
    expect(written[2]).toEqual({ sent: 0, status: 400, bytes: 10 });
    expect(readSpool(dir).join('')).not.toContain('someone');
  });
});

describe('the size of the largest telemetry events', () => {
  // The pool sizes its telemetry body cap (`MAX_BATCH_BYTES`, packages/pool/src/telemetry.ts) from these. The two event types whose size depends on a list are measured at their schema's limit, each as the spool line the CLI writes: a
  // `command` (path of 4 tokens and 40 flags, every token 32 characters, `schema.ts` `tokens`) and a `wire` (the register's whole field list, `FIELD_ROWS`, each with a seven-digit byte count). Every other type holds numbers and closed words.
  const POOL_CAP_BYTES = 512 * 1024;
  const lineOf = (type: string, fields: object): number => {
    const { dir, emitter: made } = emitter();
    emitEvent(made, type, fields);
    const line = readSpool(dir)[0];
    if (line === undefined) throw new Error(`no ${type} event was written`);
    return Buffer.byteLength(line);
  };

  it('keeps a full 250-event batch (11 wire events, the rest commands) under the pool cap, and a wire event under 3 KB', () => {
    const token = 'a'.repeat(32);
    const command = lineOf('command', { path: Array.from({ length: 4 }, () => token), flags: Array.from({ length: 40 }, () => token), durationMs: 86_400_000, exitCode: 255, errorClass: 'Error' });
    const tally = newTally();
    tallyBatch(tally, Object.fromEntries(Object.keys(FIELD_ROWS).map((name) => [name, 'x'.repeat(1_000_000)])));
    const { dir, emitter: made } = emitter();
    recordWire(made, tally);
    const wire = Buffer.byteLength(readSpool(dir)[0] ?? '');
    expect(events(dir)[0]?.data.fields).toHaveLength(Object.keys(FIELD_ROWS).length);
    expect(command).toBeLessThan(2 * 1024);
    expect(wire).toBeLessThan(3 * 1024);
    // A pass writes one `wire` event for each of the 11 harnesses at most and the rest of the 250 are commands, plus the request's own `{"install":...,"events":[...]}` frame (100 bytes with room to spare).
    expect(11 * wire + (250 - 11) * command + 100).toBeLessThan(POOL_CAP_BYTES);
  });
});
