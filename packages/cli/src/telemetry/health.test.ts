// The nightly store-health snapshot and run cost. The store is a fixture and the spool a temp folder; nothing real is read or written.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slugOf } from '../sessions/allow.js';
import { extractSession } from '../sessions/derive.js';
import { runHook } from '../sessions/hooks.js';
import { readHookCalls } from '../sessions/hook-calls.js';
import { makeRedactor } from '../sessions/redact.js';
import { appendStep } from '../sessions/steps.js';
import { deposit, frozenSessions, loadStore, readSkeletons } from '../sessions/store.js';
import { verifyAll, verifyCaptured } from '../sessions/verify.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, OLDEST_READABLE_CAPTURE } from '../sessions/schema.js';
import { cleanup, NOW, stage } from '../sessions/test-support.js';
import type * as StoreModule from '../sessions/store.js';
import type * as VerifyModule from '../sessions/verify.js';
import { closedList, readCaptured, recordStoreHealth, type NightlyTelemetry } from './health.js';
import { spoolEvents, type SpoolEvent } from './read-events.js';
import { appendLine, readSpool } from './spool.js';

// A spy on the loader, for the test of which reads the snapshot makes: the wrapped function is the real one.
vi.mock('../sessions/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof StoreModule>();
  return { ...real, loadStore: vi.fn(real.loadStore) };
});

// A spy on the skeleton check, for the test of how many skeletons the snapshot hands it at once: the wrapped function is the real one.
vi.mock('../sessions/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof VerifyModule>();
  return { ...real, verifyAll: vi.fn(real.verifyAll) };
});

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

const USAGE = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
const request = (id: string): string => JSON.stringify({ type: 'assistant', requestId: id, timestamp: '2026-06-01T12:00:00.000Z', message: { role: 'assistant', model: 'm', content: [], usage: USAGE } });
/** A cost-state line whose totals are `factor` requests' usage. */
const costState = (factor: number): string =>
  JSON.stringify({ type: 'cost-state', startTime: Date.parse('2026-06-01T00:00:00Z'), modelUsage: { m: { inputTokens: 5 * factor, cacheCreationInputTokens: 6 * factor, cacheReadInputTokens: 7 * factor, outputTokens: 8 * factor } } });
const skeletonOf = (session: string, lines: readonly string[]) =>
  extractSession({ text: lines.join('\n'), session, project: 'p', rev: 1, at: 'x', bytes: 0, redact: makeRedactor() }).skeleton;

/**
 * Skeleton files for the check of a main session and its subagents, as `deposit` names them (`<session>.json`, a subagent's `<parent>~agent-<x>.json`). Sorted by name the files do not put a
 * main beside its agents (`s1.json`, `s10.json`, `s1~agent-a.json`, ...), and `s1` and `s10` share a prefix. Totals: `s1` holds its own request and its agents' (equal, as the harness records them);
 * `s2`'s total is one request but its agent adds a second (a violation); `s10` is its own; `s3~agent-z` is an agent whose main is not in the store. One file is torn.
 */
const writeSkeletons = (storeDir: string): void => {
  const folder = join(storeDir, 'skeletons');
  mkdirSync(folder, { recursive: true });
  const put = (session: string, lines: readonly string[]): void => writeFileSync(join(folder, `${session}.json`), JSON.stringify(skeletonOf(session, lines)));
  put('s1', [request('r1'), costState(3)]);
  put('s1~agent-a', [request('r2')]);
  put('s1~agent-b', [request('r3')]);
  put('s2', [request('r4'), costState(1)]);
  put('s2~agent-c', [request('r5')]);
  put('s10', [request('r6'), costState(1)]);
  put('s3~agent-z', [request('r7')]);
  writeFileSync(join(folder, 'torn.json'), '{"session":"torn","lines":[');
};

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
      captureVersions: [Number(CAPTURE_VERSION)],
      extractorVersions: [Number(EXTRACTOR_VERSION)],
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

  it('never reads the whole store at once: every read of the log names the sessions of one run', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const { dir, telemetry } = emitter();
    const reads = vi.mocked(loadStore);
    reads.mockClear();
    await recordStoreHealth(telemetry, { ...staged.runtime, refreshRun: 1 });
    expect(events(dir, 'store-health')[0]?.data.readFailed).toBeUndefined();
    expect(reads.mock.calls.filter(([, , options]) => options?.only === undefined)).toEqual([]);
  });

  it('hands the skeleton check one main session with its subagents at a time, never the whole store', async () => {
    const staged = stage(slugOf(REPO));
    writeSkeletons(staged.storeDir);
    const { dir, telemetry } = emitter();
    const checks = vi.mocked(verifyAll);
    checks.mockClear();
    await recordStoreHealth(telemetry, staged.runtime);
    expect(events(dir, 'store-health')[0]?.data.readFailed).toBeUndefined();
    // Seven skeletons: `s1` with two subagents, `s2` with one, `s10` alone, and the subagent of a main that is not in the store. The torn file is no skeleton, so its group holds none and is not checked.
    expect(checks.mock.calls.map(([skeletons]) => skeletons.length).sort((a, b) => a - b)).toEqual([1, 1, 2, 3]);
    expect(checks.mock.calls.every(([skeletons, delegatedFrom]) => delegatedFrom === skeletons)).toBe(true);
  });

  it('emits the event the whole-array read did, over mains with subagents and an orphan subagent', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    writeSkeletons(staged.storeDir);
    const { dir, telemetry } = emitter();
    await recordStoreHealth(telemetry, staged.runtime);

    // The old path, composed here from the whole reads: every skeleton at once into `verifyAll`, the whole store into `verifyCaptured`.
    const { skeletons, unreadable } = await readSkeletons(staged.storeDir, undefined, true);
    const store = await loadStore(staged.storeDir);
    const captured = [...store.sessions, ...store.subagents];
    const frozen = await frozenSessions(staged.runtime, captured.filter((session) => Number(session.cv) >= OLDEST_READABLE_CAPTURE && Number(session.cv) < Number(CAPTURE_VERSION)));
    const results = [...verifyAll(skeletons, skeletons), ...verifyCaptured(captured, store.tools, frozen)];
    // `s2`'s agent makes its cost-state total fall short of the usage, which only the join of the agent to its main shows: the fixture must make the cost row fail.
    expect(results[5]).toMatchObject({ checked: 12, violations: 4 });
    expect(unreadable).toBe(1);
    expect(events(dir, 'store-health')[0]?.data).toEqual({
      sessions: store.sessions.length,
      subagents: store.subagents.length,
      skeletons: skeletons.length,
      unparseable: unreadable + captured.reduce((sum, session) => sum + session.badLines, 0),
      rawBytes: bytesUnder(join(staged.storeDir, 'raw')),
      verifyChecked: results.length,
      verifyFailed: results.filter((result) => result.violations > 0).length,
      captureVersions: [Number(CAPTURE_VERSION)],
      extractorVersions: [],
      harnessVersions: closedList(captured.flatMap((session) => session.versions), 'version'),
      models: closedList(captured.flatMap((session) => Object.keys(session.models)), 'model'),
      outboxBytes: 0,
      egressBytes: 0,
    });
  });

  it('answers every capture row as a whole-store read does, with a violation in each, over runs of one session', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    // Break each row of `verifyCaptured` once: a session behind the current capture version, a second `sid`, a file hash no call explains, and a call whose `targetBase` does not fit its target.
    const log = join(staged.storeDir, 'observations.jsonl');
    const rows = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').map((line): { [key: string]: unknown } => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('a log line is not an object');
      return Object.fromEntries(Object.entries(parsed));
    });
    const sessionRows = rows.filter((row) => row.kind === 'session' && row.parent === null);
    const [behind, other, hashed] = sessionRows;
    const call = rows.find((row) => row.kind === 'tool' && row.targetBase === null && row.cv === CAPTURE_VERSION);
    if (behind === undefined || other === undefined || hashed === undefined || call === undefined) throw new Error('the fixture holds too few rows');
    behind.cv = String(Number(CAPTURE_VERSION) - 1);
    other.sid = 'another-salt';
    hashed.fileHashes = ['0123456789abcdef'];
    call.targetBase = 'cwd';
    writeFileSync(log, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const whole = await loadStore(staged.storeDir);
    const captured = [...whole.sessions, ...whole.subagents];
    const frozen = await frozenSessions(staged.runtime, captured.filter((session) => Number(session.cv) >= 3 && Number(session.cv) < Number(CAPTURE_VERSION)));
    const expected = verifyCaptured(captured, whole.tools, frozen);
    expect(expected.every((row) => row.violations > 0)).toBe(true);
    for (const refreshRun of [1, 2, undefined]) {
      const read = await readCaptured({ ...staged.runtime, ...(refreshRun === undefined ? {} : { refreshRun }) });
      expect(read.capture).toEqual(expected);
      expect(read.sessions).toHaveLength(whole.sessions.length);
      expect(read.subagents).toHaveLength(whole.subagents.length);
    }
  });

  it('records the versions the store holds, not the ones this build writes', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    // One session captured by an older oars, and a step an older extractor ran: the capture half holds two versions here; the extractor half is the next test.
    const log = join(staged.storeDir, 'observations.jsonl');
    const lines = readFileSync(log, 'utf8').split('\n');
    const current = `"cv":"${CAPTURE_VERSION}"`;
    const older = `"cv":"${String(Number(CAPTURE_VERSION) - 1)}"`;
    const index = lines.findIndex((line) => line.includes('"kind":"session"') && line.includes(current));
    expect(index).toBeGreaterThanOrEqual(0);
    lines[index] = (lines[index] ?? '').replace(current, older);
    writeFileSync(log, lines.join('\n'));
    await appendStep(staged.storeDir, { at: new Date(NOW).toISOString(), run: 'r', trigger: 'nightly', step: 'deposit', status: 'ok', ms: 1, in: {}, out: {}, cv: String(Number(CAPTURE_VERSION) - 1), ev: '11', key: null, error: null });
    const { dir, telemetry } = emitter();
    await recordStoreHealth(telemetry, staged.runtime);

    const [health] = events(dir, 'store-health');
    expect(health?.data.readFailed).toBeUndefined();
    expect(health?.data.captureVersions).toEqual([Number(CAPTURE_VERSION) - 1, Number(CAPTURE_VERSION)]);
    expect(health?.data.extractorVersions).toEqual([11]);
    expect(health?.data.captureVersion).toBeUndefined();
    expect(health?.data.extractorVersion).toBeUndefined();
  });

  it('lists the extractor version each pipeline step last ran at, not every version the log has seen', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const row = (step: 'deposit' | 'verify', ev: string, minute: number): Promise<void> =>
      appendStep(staged.storeDir, { at: new Date(NOW + minute * 60_000).toISOString(), run: 'r', trigger: 'nightly', step, status: 'ok', ms: 1, in: {}, out: {}, cv: CAPTURE_VERSION, ev, key: null, error: null });
    // `deposit` ran at 11 and later at 12 (written out of order, as a log can be): only 12 is what it last ran at.
    await row('deposit', '12', 2);
    await row('deposit', '11', 1);
    const first = emitter();
    await recordStoreHealth(first.telemetry, staged.runtime);
    expect(events(first.dir, 'store-health')[0]?.data.extractorVersions).toEqual([12]);

    // `verify` last ran at 11 beside `deposit` at 12: both versions are still in the store's steps.
    await row('verify', '10', 1);
    await row('verify', '11', 3);
    const second = emitter();
    await recordStoreHealth(second.telemetry, staged.runtime);
    expect(events(second.dir, 'store-health')[0]?.data.extractorVersions).toEqual([11, 12]);
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
