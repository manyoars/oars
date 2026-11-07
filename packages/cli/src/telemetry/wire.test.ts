// Wire policing: for each deposit pass, which fields of the register each harness's batches held and how many bytes each took, and what the pool answered a send.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIELD_ROWS } from '../sessions/pool-outbox.js';
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
