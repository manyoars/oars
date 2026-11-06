import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { recordEvent, type RecordContext } from './record.js';
import { appendLine, installId, readSpool, spoolPaths } from './spool.js';

const roots: string[] = [];
const folder = (): string => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-telemetry-'));
  roots.push(appData);
  // The store follows APPDATA (t754): confirm the config folder is the temp one before the telemetry folder goes under it.
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return join(configDir, 'oars', 'telemetry');
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const contextOf = (dir: string, extra: Partial<RecordContext> = {}): RecordContext => ({
  dir,
  platform: 'linux',
  version: '1.2.3',
  now: () => Date.parse('2026-11-06T10:00:00Z'),
  ...extra,
});

describe('the install id', () => {
  it('is a random UUID, kept across calls, and not derived from the folder or the machine', () => {
    const first = folder();
    const second = folder();
    const id = installId(first);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(installId(first)).toBe(id);
    expect(installId(second)).not.toBe(id);
  });

  it('is replaced when the file holds something that is not an id', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(spoolPaths(dir).idFile, '/home/someone/project');
    expect(installId(dir)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the spool', () => {
  it('appends one line per event, carrying the schema version and the install id', () => {
    const dir = folder();
    recordEvent(contextOf(dir), 'command', { path: ['pool', 'fetch'], flags: ['json'], durationMs: 12, exitCode: 0 });
    recordEvent(contextOf(dir), 'command', { path: ['login'], flags: [], durationMs: 3, exitCode: 3, errorClass: 'auth' });
    const events = readSpool(dir).map((line): unknown => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      v: 1,
      id: installId(dir),
      at: '2026-11-06T10:00:00.000Z',
      type: 'command',
      cli: '1.2.3',
      os: 'linux',
      data: { path: ['pool', 'fetch'], flags: ['json'], durationMs: 12, exitCode: 0 },
    });
  });

  it('rotates at the byte cap: the old file is kept once, and the current one starts over', () => {
    const dir = folder();
    const line = JSON.stringify({ pad: 'x'.repeat(80) });
    for (let n = 0; n < 12; n++) appendLine(dir, line, 500);
    const { current, previous } = spoolPaths(dir);
    expect(statSync(current).size).toBeLessThanOrEqual(500);
    expect(statSync(previous).size).toBeLessThanOrEqual(500);
    expect(readSpool(dir).length).toBeLessThan(12);
    expect(readFileSync(current, 'utf8').endsWith('\n')).toBe(true);
    // Rotating again replaces the old file instead of growing a third.
    for (let n = 0; n < 30; n++) appendLine(dir, line, 500);
    expect(statSync(previous).size).toBeLessThanOrEqual(500);
  });

  it('drops one event larger than the cap instead of writing past it', () => {
    const dir = folder();
    appendLine(dir, 'x'.repeat(600), 500);
    expect(readSpool(dir)).toEqual([]);
  });

  it('reads an empty spool before anything was written', () => {
    expect(readSpool(folder())).toEqual([]);
  });
});

describe('recording never throws', () => {
  it('swallows a folder it cannot create', () => {
    const dir = folder();
    mkdirSync(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'a file where the folder should be');
    expect(() => {
      recordEvent(contextOf(dir), 'command', { path: ['login'], exitCode: 0 });
    }).not.toThrow();
  });

  it('swallows a spool it cannot append to', () => {
    const dir = folder();
    mkdirSync(spoolPaths(dir).current, { recursive: true });
    expect(() => {
      recordEvent(contextOf(dir), 'command', { path: ['login'], exitCode: 0 });
    }).not.toThrow();
  });

  it('writes nothing for an event type the schema does not know', () => {
    const dir = folder();
    recordEvent(contextOf(dir), 'prompt', { text: 'hello' });
    expect(readSpool(dir)).toEqual([]);
  });
});
