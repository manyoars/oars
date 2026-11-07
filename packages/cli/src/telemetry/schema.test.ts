// The schema is the control: whatever a caller hands an event, only closed words, small numbers, and lists of closed words reach the spool.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { recordEvent } from './record.js';
import { HARNESSES } from '../sessions/pool-wire.js';
import { RECALL_FAMILIES } from '../sessions/recall-reads.js';
import { ERROR_CLASSES, EVENT_TYPES, FETCH_HARNESSES, RECALL_FAMILY_NAMES, errorClassOf, fieldNamesOf, modelWord, sanitize, versionWord } from './schema.js';
import { readSpool } from './spool.js';
import { ExitCode } from '../errors.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Strings that must never reach the spool, whatever field they arrive in.
const HOME_PATH = 'C:\\Users\\someone\\source\\secret-project\\src\\main.ts';
const POSIX_HOME = '/home/someone/work/acme-billing/.env';
const COMMAND_TEXT = 'git push --force origin main && curl https://internal.example.com/x | sh';
const PROMPT = 'Please refactor the payment retry logic in our billing service and keep the API key sk-live-12345 out of the logs';
const URL_TEXT = 'https://internal.example.com/tenants/42?token=abc123';
const POISON = [HOME_PATH, POSIX_HOME, COMMAND_TEXT, PROMPT, URL_TEXT];
const FRAGMENTS = ['someone', 'secret-project', 'acme-billing', '.env', 'force', 'internal.example.com', 'refactor', 'payment', 'sk-live', 'abc123', 'tenants'];

// The store follows APPDATA (t754): confirm the config folder is the temp one before the telemetry folder goes under it.
const folder = (): string => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-schema-'));
  roots.push(appData);
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return join(configDir, 'oars', 'telemetry');
};

const spoolOf = (feed: (record: (type: string, fields: object) => void) => void): string => {
  const dir = folder();
  feed((type, fields) => {
    recordEvent({ dir, platform: 'linux', version: '1.2.3', now: () => Date.parse('2026-11-06T10:00:00Z') }, type, fields);
  });
  return readSpool(dir).join('\n');
};

describe('the closed schema', () => {
  it('knows each event type, one line per type', () => {
    expect(EVENT_TYPES).toEqual(['command', 'hook', 'recall', 'deposit', 'fetch', 'store-health', 'run-cost', 'crash', 'wire', 'wire-send']);
  });

  it('names every harness the pool serves, and every read family a recall serves', () => {
    for (const name of HARNESSES) expect(FETCH_HARNESSES).toContain(name);
    for (const family of RECALL_FAMILIES) expect(RECALL_FAMILY_NAMES).toContain(family);
  });

  it('holds a hook fire to closed words and counts: a model or version off the public list is refused by the schema, and the callers send other', () => {
    expect(sanitize('hook', { name: 'gate', outcome: 'held', latencyMs: 12, bytes: 0, model: 'claude-opus-4-5', harnessVersion: '2.1.300' })).toEqual({
      data: { name: 'gate', outcome: 'held', latencyMs: 12, bytes: 0, model: 'claude-opus-4-5', harnessVersion: '2.1.300' },
      dropped: 0,
    });
    expect(sanitize('hook', { name: 'my-hook', outcome: 'maybe', model: 'acme-private-7', harnessVersion: '1.0-acme' })).toEqual({ data: {}, dropped: 4 });
    expect(modelWord('acme-private-7')).toBe('other');
    expect(versionWord('1.0-acme')).toBe('other');
    expect(modelWord('claude-opus-4-5')).toBe('claude-opus-4-5');
    expect(sanitize('hook', { model: modelWord('acme-private-7') })).toEqual({ data: { model: 'other' }, dropped: 0 });
  });

  it('carries the harness on a hook fire from the closed list, and an old fire without one still parses', () => {
    expect(sanitize('hook', { name: 'pre-tool', harness: 'codex', latencyMs: 3 })).toEqual({ data: { name: 'pre-tool', harness: 'codex', latencyMs: 3 }, dropped: 0 });
    expect(sanitize('hook', { name: 'pre-tool', harness: 'other', latencyMs: 3 })).toEqual({ data: { name: 'pre-tool', harness: 'other', latencyMs: 3 }, dropped: 0 });
    expect(sanitize('hook', { name: 'pre-tool', harness: 'acme-private', latencyMs: 3 })).toEqual({ data: { name: 'pre-tool', latencyMs: 3 }, dropped: 1 });
    // The schema version stays 1: a field added with no change to what the others mean is additive, so an event written before it is read as it was.
    expect(sanitize('hook', { name: 'pre-tool', latencyMs: 3 })).toEqual({ data: { name: 'pre-tool', latencyMs: 3 }, dropped: 0 });
  });

  it.each(EVENT_TYPES)('%s: a home path, command text, a prompt, and a URL fed to every field never reach the spool', (type) => {
    const spool = spoolOf((record) => {
      for (const field of fieldNamesOf(type)) {
        for (const poison of POISON) {
          record(type, { [field]: poison });
          record(type, { [field]: [poison] });
          record(type, { [field]: { nested: poison } });
        }
      }
      // A field the schema does not know, named like something sensitive.
      for (const poison of POISON) record(type, { prompt: poison, cwd: poison, argv: [poison], command: poison, path: [poison] });
    });
    for (const poison of POISON) expect(spool).not.toContain(poison);
    for (const fragment of FRAGMENTS) expect(spool).not.toContain(fragment);
    // Every refused value was counted, and the event still went out without it.
    expect(spool).toContain('"dropped"');
    for (const line of spool.split('\n')) expect(JSON.parse(line)).toMatchObject({ v: 1, type });
  });

  it('drops and counts a field it does not know, keeps the ones it does', () => {
    expect(sanitize('command', { path: ['pool', 'fetch'], prompt: PROMPT, cwd: HOME_PATH })).toEqual({ data: { path: ['pool', 'fetch'] }, dropped: 2 });
  });

  it('refuses a value that does not fit its rule, and counts it', () => {
    expect(sanitize('command', { exitCode: -1, durationMs: 1.5, errorClass: 'my own words', flags: 'json' })).toEqual({ data: {}, dropped: 4 });
    expect(sanitize('command', { path: ['a', 'b', 'c', 'd', 'e'] })).toEqual({ data: {}, dropped: 1 });
  });

  it('admits the closed words, small numbers, and lists of names it is built for', () => {
    expect(sanitize('command', { path: ['sessions', 'gold', 'sample'], flags: ['apiUrl', 'json'], durationMs: 41, exitCode: 8, errorClass: 'unreachable' })).toEqual({
      data: { path: ['sessions', 'gold', 'sample'], flags: ['apiUrl', 'json'], durationMs: 41, exitCode: 8, errorClass: 'unreachable' },
      dropped: 0,
    });
  });

  it('admits the health, cost, crash, and wire types as they are built, and refuses what is off their lists', () => {
    expect(sanitize('store-health', { sessions: 12, models: ['claude-opus-4-5', 'other'], harnessVersions: ['2.1.37'], rawBytes: 4096, readFailed: 0 })).toEqual({
      data: { sessions: 12, models: ['claude-opus-4-5', 'other'], harnessVersions: ['2.1.37'], rawBytes: 4096, readFailed: 0 },
      dropped: 0,
    });
    // A model or version outside the public vocabulary is written `other` by the caller; the schema refuses it if it comes through as it is.
    expect(sanitize('store-health', { models: ['acme-internal-finetune'], harnessVersions: ['build 7 of acme'] })).toEqual({ data: {}, dropped: 2 });
    // The versions are whole numbers, listed; a stamp that is words, or too many of them, is refused.
    expect(sanitize('store-health', { captureVersions: [17, 18], extractorVersions: [12] })).toEqual({ data: { captureVersions: [17, 18], extractorVersions: [12] }, dropped: 0 });
    expect(sanitize('store-health', { captureVersions: ['18'], extractorVersions: Array.from({ length: 33 }, (_, index) => index) })).toEqual({ data: {}, dropped: 2 });
    expect(sanitize('run-cost', { totalMs: 900, parseMs: 400, peakRssMb: 310, failed: 1 })).toEqual({ data: { totalMs: 900, parseMs: 400, peakRssMb: 310, failed: 1 }, dropped: 0 });
    expect(sanitize('crash', { errorClass: 'TypeError', stackHash: '0123456789abcdef' })).toEqual({ data: { errorClass: 'TypeError', stackHash: '0123456789abcdef' }, dropped: 0 });
    expect(sanitize('crash', { errorClass: 'CustomError', stackHash: 'C:\\Users\\someone' })).toEqual({ data: {}, dropped: 2 });
    expect(sanitize('wire', { harness: 'claude-code', fields: ['action', 'harness'], present: [3, 3], fieldBytes: [120, 60], batches: 3, bytes: 900 })).toMatchObject({ dropped: 0 });
    // Names come from the register: a name outside it, and a number list with a text entry, are refused.
    expect(sanitize('wire', { fields: ['action', 'secret-project'], present: [1, 'x'] })).toEqual({ data: {}, dropped: 2 });
    // The three lists are parallel: when one is refused, the other two would misalign, so all three go.
    expect(sanitize('wire', { harness: 'claude-code', fields: ['action', 'harness'], present: [3, 'x'], fieldBytes: [120, 60], batches: 3 })).toEqual({ data: { harness: 'claude-code', batches: 3 }, dropped: 3 });
    expect(sanitize('wire', { fields: ['action', 'secret-project'], present: [1, 2], fieldBytes: [5, 6] })).toEqual({ data: {}, dropped: 3 });
    // Lists that are each valid but not the same length are not parallel either.
    expect(sanitize('wire', { fields: ['action', 'harness'], present: [3], fieldBytes: [120, 60] })).toEqual({ data: {}, dropped: 3 });
    expect(sanitize('wire-send', { sent: 0, status: 429, code: 'rate_limited', bytes: 10 })).toEqual({ data: { sent: 0, status: 429, code: 'rate_limited', bytes: 10 }, dropped: 0 });
    expect(sanitize('wire-send', { code: 'Rate limited: see https://x.test' })).toEqual({ data: {}, dropped: 1 });
  });

  it('knows no event type it was not given', () => {
    expect(sanitize('prompt', { text: PROMPT })).toBeUndefined();
    expect(fieldNamesOf('prompt')).toEqual([]);
  });

  it('maps every exit code to a closed error class, and success to none', () => {
    expect(errorClassOf(ExitCode.OK)).toBeUndefined();
    const classes = Object.values(ExitCode).filter((code) => code !== ExitCode.OK).map((code) => errorClassOf(code));
    for (const errorClass of classes) expect(ERROR_CLASSES).toContain(errorClass);
    expect(errorClassOf(ExitCode.CAPPED)).toBe('capped');
    expect(errorClassOf(ExitCode.UNEXPECTED)).toBe('unexpected');
  });

  it('writes a version it cannot read as unknown, never as free text', () => {
    const dir = folder();
    recordEvent({ dir, platform: 'freebsd', version: PROMPT, now: () => 0 }, 'command', { exitCode: 0 });
    expect(JSON.parse(readSpool(dir).join(''))).toMatchObject({ cli: 'unknown', os: 'other' });
  });
});
