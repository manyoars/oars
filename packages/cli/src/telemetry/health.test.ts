// The nightly store-health snapshot and run cost. The store is a fixture and the spool a temp folder; nothing real is read or written.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from '../sessions/allow.js';
import { runHook } from '../sessions/hooks.js';
import { readHookCalls } from '../sessions/hook-calls.js';
import { appendStep } from '../sessions/steps.js';
import { deposit, loadStore } from '../sessions/store.js';
import { cleanup, NOW, stage } from '../sessions/test-support.js';
import { closedList, recordStoreHealth, type NightlyTelemetry } from './health.js';
import { spoolEvents, type SpoolEvent } from './read-events.js';
import { appendLine, readSpool } from './spool.js';

const roots: string[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPO = join('work', 'app');

const bytesUnder = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? bytesUnder(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0);

/** A telemetry folder under a temp APPDATA, an emitter for it, and a clock that moves 5 ms at each reading. */
const emitter = (peak = 321): { telemetry: NightlyTelemetry; dir: string } => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-health-'));
  roots.push(appData);
  const dir = join(appData, 'oars', 'telemetry');
  let tick = NOW;
  return { dir, telemetry: { env: { APPDATA: appData }, telemetry: { dir, platform: 'linux' }, version: '1.2.3', now: () => (tick += 5), peakRssMb: () => peak } };
};

const events = (dir: string, type: string): SpoolEvent[] => spoolEvents(dir, type);

describe('store health at the nightly run', () => {
  it('snapshots a fixture store against a hand count', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const { dir, telemetry } = emitter();
    await runHook('nightly', '', staged.runtime, () => NOW, telemetry);

    const [health] = events(dir, 'store-health');
    const store = await loadStore(staged.storeDir);
    expect(health?.data).toMatchObject({
      sessions: store.sessions.length,
      subagents: store.subagents.length,
      skeletons: readdirSync(join(staged.storeDir, 'skeletons')).length,
      rawBytes: bytesUnder(join(staged.storeDir, 'raw')),
      captureVersions: [18],
      extractorVersions: [12],
      unparseable: [...store.sessions, ...store.subagents].reduce((sum, session) => sum + session.badLines, 0),
    });
    expect(store.sessions.length).toBeGreaterThan(0);
    expect(health?.data.rawBytes).toBeGreaterThan(0);
    expect(health?.data.verifyChecked).toBeGreaterThan(0);
    expect(health?.data.readFailed).toBeUndefined();
    // Versions and models are the ones the store holds, or `other`: nothing else can be written.
    const seen = [...store.sessions, ...store.subagents];
    expect(health?.data.harnessVersions).toEqual(closedList(seen.flatMap((session) => session.versions), 'version'));
    expect(health?.data.models).toEqual(closedList(seen.flatMap((session) => Object.keys(session.models)), 'model'));
  });

  it('records the versions the store holds, not the ones this build writes', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    // One session captured by an older oars, and a step an older extractor ran: the store now holds two of each.
    const log = join(staged.storeDir, 'observations.jsonl');
    const lines = readFileSync(log, 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes('"kind":"session"') && line.includes('"cv":"18"'));
    expect(index).toBeGreaterThanOrEqual(0);
    lines[index] = (lines[index] ?? '').replace('"cv":"18"', '"cv":"17"');
    writeFileSync(log, lines.join('\n'));
    await appendStep(staged.storeDir, { at: new Date(NOW).toISOString(), run: 'r', trigger: 'nightly', step: 'deposit', status: 'ok', ms: 1, in: {}, out: {}, cv: '17', ev: '11', key: null, error: null });
    const { dir, telemetry } = emitter();
    await recordStoreHealth(telemetry, staged.runtime);

    const [health] = events(dir, 'store-health');
    expect(health?.data.readFailed).toBeUndefined();
    expect(health?.data.captureVersions).toEqual([17, 18]);
    expect(health?.data.extractorVersions).toEqual([11]);
    expect(health?.data.captureVersion).toBeUndefined();
    expect(health?.data.extractorVersion).toBeUndefined();
  });

  it('reads a store that fails to read as a failure, records it, and does not stop the nightly run', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    // The observation log is a folder, so the store cannot be loaded; state.json is intact, so the run still has its allowlist.
    rmSync(join(staged.storeDir, 'observations.jsonl'));
    mkdirSync(join(staged.storeDir, 'observations.jsonl'));
    const { dir, telemetry } = emitter();
    await runHook('nightly', '', staged.runtime, () => NOW, telemetry);

    expect(events(dir, 'store-health').map((event) => event.data)).toEqual([{ readFailed: 1 }]);
    // The run itself was counted, whatever happened to the snapshot.
    expect(await readHookCalls(staged.storeDir)).toHaveLength(1);
    expect(events(dir, 'run-cost')).toHaveLength(1);
  });

  it('adds the bytes the outbox holds and the bytes sent in the last seven days', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const outbox = join(staged.storeDir, 'pool-outbox', 'abc', 'stamp');
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'one.jsonl'), 'x'.repeat(1000));
    const { dir, telemetry } = emitter();
    const record = (daysAgo: number, bytes: number, sent: number): void => {
      const at = new Date(NOW - daysAgo * 86_400_000).toISOString();
      appendLine(dir, JSON.stringify({ v: 1, id: 'x', at, type: 'wire-send', cli: '1.2.3', os: 'linux', data: { sent, status: 201, bytes } }));
    };
    record(2, 700, 1);
    record(6, 300, 1);
    record(10, 5000, 1);
    record(1, 9000, 0);
    await runHook('nightly', '', staged.runtime, () => NOW, telemetry);

    const [health] = events(dir, 'store-health');
    expect(health?.data.outboxBytes).toBe(1000);
    expect(health?.data.egressBytes).toBe(1000);
  });
});

describe('run cost at the nightly run', () => {
  it('records the parse time, the peak memory, and a good run as not failed', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const { dir, telemetry } = emitter(321);
    await runHook('nightly', '', staged.runtime, () => NOW, telemetry);
    const [cost] = events(dir, 'run-cost');
    expect(cost?.data).toMatchObject({ peakRssMb: 321, failed: 0 });
    // The clock moves 5 ms per reading: the whole run read it more often than the parse alone did.
    expect(Number(cost?.data.parseMs)).toBeGreaterThan(0);
    expect(Number(cost?.data.totalMs)).toBeGreaterThan(Number(cost?.data.parseMs));
  });

  it('records a run that failed as failed, and still raises nothing to the hook', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    // A projects root that is a file: the deposit fails.
    const { dir, telemetry } = emitter();
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    writeFileSync(staged.projectsRoot, 'a file where the projects folder should be');
    await runHook('nightly', '', staged.runtime, () => NOW, telemetry);
    expect(events(dir, 'run-cost')[0]?.data).toMatchObject({ failed: 1 });
  });

  it('records nothing when telemetry is off', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const { dir, telemetry } = emitter();
    await runHook('nightly', '', staged.runtime, () => NOW, { ...telemetry, env: { ...telemetry.env, OARS_TELEMETRY: '0' } });
    expect(readSpool(dir)).toEqual([]);
  });

  it('never reads the store when telemetry is off, so an install that opted out pays nothing at night', async () => {
    const staged = stage(slugOf(REPO));
    const { telemetry } = emitter();
    let reads = 0;
    const watched = Object.defineProperty({ ...staged.runtime }, 'storeDir', {
      get: () => {
        reads += 1;
        return staged.storeDir;
      },
    });
    await recordStoreHealth({ ...telemetry, env: { ...telemetry.env, DO_NOT_TRACK: '1' } }, watched);
    expect(reads).toBe(0);
    // The same call with telemetry on does read it.
    await recordStoreHealth(telemetry, watched);
    expect(reads).toBeGreaterThan(0);
  });
});

describe('closed lists', () => {
  it('keeps a public value, maps anything else to other, and lists each once, sorted', () => {
    expect(closedList(['2.1.37', 'my build 7', '2.1.37', '1.0.0', '/home/someone/x'], 'version')).toEqual(['1.0.0', '2.1.37', 'other']);
    expect(closedList(['claude-opus-4-5', 'internal-finetune-acme', 'claude-opus-4-5'], 'model')).toEqual(['claude-opus-4-5', 'other']);
    expect(closedList([], 'model')).toEqual([]);
  });

  it('folds the tail into other past the list length, so the list stays inside the schema', () => {
    const many = Array.from({ length: 40 }, (_, index) => `1.${String(index)}.0`);
    const list = closedList(many, 'version');
    expect(list).toHaveLength(32);
    expect(list.at(-1)).toBe('other');
  });
});
