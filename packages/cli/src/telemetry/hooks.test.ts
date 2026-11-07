// Every hook fire leaves one `hook` event, and the hook's stdout is the same bytes with telemetry on, off, and broken. Every test sets APPDATA to a temp folder and
// confirms the telemetry folder is under it, so none touches the real one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GateHookDeps } from '../gate/hook.js';
import { fireRecorder } from '../gate/hook-record.js';
import { runHookProcess } from '../gate/hook-process.js';
import { folderKey } from '../gate/record.js';
import { defaultConfigDir } from '../credentials.js';
import { slugOf } from '../sessions/allow.js';
import { indexPath, type HookIndex } from '../sessions/hook-index.js';
import { runHook } from '../sessions/hooks.js';
import { armOf } from '../sessions/recall-object.js';
import { toolShapeId, type RecallRead } from '../sessions/recall-reads.js';
import { deposit } from '../sessions/store.js';
import { cleanup, NOW, stage } from '../sessions/test-support.js';
import { emitFor, type Emit } from './emit.js';
import { readSpool } from './spool.js';

const roots: string[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A telemetry folder under a temp APPDATA, the way the CLI puts it. */
const spoolFolder = (): string => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-hook-telemetry-'));
  roots.push(appData);
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return join(configDir, 'oars', 'telemetry');
};

const emitterAt = (dir: string, env: NodeJS.ProcessEnv = {}): Emit => emitFor({ env, telemetry: { dir, platform: 'linux' }, version: () => '1.2.3', now: () => NOW });


interface Logged {
  type: string;
  cli: string;
  data: { [field: string]: unknown };
}
const isLogged = (value: unknown): value is Logged => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string' && typeof Reflect.get(value, 'cli') === 'string' && typeof Reflect.get(value, 'data') === 'object';
/** One spool line as an event; a line that is not one fails the test that read it. */
const eventOf = (line: string): Logged => {
  const value: unknown = JSON.parse(line);
  if (!isLogged(value)) throw new Error(`not an event: ${line}`);
  return value;
};

const logged = (dir: string): Logged[] => readSpool(dir).map(eventOf);
const hooks = (dir: string): Logged[] => logged(dir).filter((event) => event.type === 'hook');

const REPO = join('work', 'app');
const QUOTING = 'bash: -c: line 7: unexpected EOF while looking for matching quote';
const AT = '2026-11-01T00:00:00.000Z';
const SHAPE = toolShapeId('Monitor', ['query', 'max_results']);
const read: RecallRead = { readId: SHAPE, family: 'fit', tool: 'Monitor', keys: ['max_results', 'query'], n: 40, count: 175, calls: 175, clusters: 1, firstDay: '2026-10-01', lastDay: '2026-10-30', harnesses: ['claude-code'], harnessVersions: ['2.1.300'], models: ['claude-opus-4-5'], followed: [['Bash', 12]] };

const withIndex = (): ReturnType<typeof stage> => {
  const staged = stage();
  mkdirSync(staged.storeDir, { recursive: true });
  const index: HookIndex = { at: AT, redactDomains: [], projects: {}, signatures: {}, fit: { [SHAPE]: read } };
  writeFileSync(indexPath(staged.storeDir), JSON.stringify(index));
  return staged;
};

const sessionOn = (arm: 'shown' | 'held'): string => {
  for (let index = 0; index < 10_000; index += 1) if (armOf(`session-${String(index)}`, [SHAPE], AT) === arm) return `session-${String(index)}`;
  throw new Error('no session on that arm');
};

const monitor = (sid: string): string => JSON.stringify({ session_id: sid, tool_name: 'Monitor', tool_input: { query: 'a typed value', max_results: 3 }, hook_event_name: 'PreToolUse' });

const deposited = async (): Promise<ReturnType<typeof stage>> => {
  const staged = stage(slugOf(REPO));
  await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  return staged;
};

describe('a session hook records one event per fire', () => {
  it('session-start: a hit records the bytes it injected, a miss records none, and the model comes from the hook input', async () => {
    const dir = spoolFolder();
    const { runtime } = await deposited();
    const hit = await runHook('session-start', JSON.stringify({ session_id: 'live', cwd: REPO, model: 'claude-opus-4-5' }), runtime, () => NOW, undefined, emitterAt(dir));
    await runHook('session-start', JSON.stringify({ cwd: join('elsewhere', 'other') }), runtime, () => NOW, undefined, emitterAt(dir));
    const [first, second] = hooks(dir);
    expect(first?.data).toMatchObject({ name: 'session-start', outcome: 'hit', bytes: Buffer.byteLength(hit ?? ''), model: 'claude-opus-4-5' });
    expect(typeof first?.data.latencyMs).toBe('number');
    expect(second?.data).toMatchObject({ name: 'session-start', outcome: 'miss', bytes: 0 });
    expect(hooks(dir)).toHaveLength(2);
  });

  it('a model off the public list goes as other, never as the name', async () => {
    const dir = spoolFolder();
    const { runtime } = await deposited();
    await runHook('session-start', JSON.stringify({ cwd: REPO, model: 'acme-internal-finetune-7' }), runtime, () => NOW, undefined, emitterAt(dir));
    expect(hooks(dir)[0]?.data.model).toBe('other');
    expect(readSpool(dir).join('')).not.toContain('acme-internal');
  });

  it('post-tool: a failure the index knows is a hit, an unknown one a miss', async () => {
    const dir = spoolFolder();
    const { runtime } = await deposited();
    await runHook('post-tool', JSON.stringify({ session_id: 'p', tool_name: 'Bash', tool_response: `Exit code 2\n${QUOTING}` }), runtime, () => NOW, undefined, emitterAt(dir));
    await runHook('post-tool', JSON.stringify({ session_id: 'p', tool_name: 'Bash', tool_response: 'ok' }), runtime, () => NOW, undefined, emitterAt(dir));
    expect(hooks(dir).map((event) => event.data.outcome)).toEqual(['hit', 'miss']);
    expect(hooks(dir).map((event) => event.data.name)).toEqual(['post-tool', 'post-tool']);
  });

  it('pre-tool: a shown push is a hit with its bytes and the frame a transcript states, a held push is held with no bytes, and each also records its recall', async () => {
    const dir = spoolFolder();
    const staged = withIndex();
    const transcript = join(staged.storeDir, 'transcript.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ version: '2.1.300', message: { model: 'claude-opus-4-5' } })}\n`);
    const shown = await runHook('pre-tool', JSON.stringify({ ...JSON.parse(monitor(sessionOn('shown'))), transcript_path: transcript }), staged.runtime, () => NOW, undefined, emitterAt(dir));
    const held = await runHook('pre-tool', monitor(sessionOn('held')), staged.runtime, () => NOW, undefined, emitterAt(dir));
    expect(held).toBeUndefined();
    const [one, two] = hooks(dir);
    expect(one?.data).toMatchObject({ name: 'pre-tool', outcome: 'hit', bytes: Buffer.byteLength(shown ?? ''), harness: 'claude-code', harnessVersion: '2.1.300', model: 'claude-opus-4-5' });
    expect(two?.data).toMatchObject({ name: 'pre-tool', outcome: 'held', bytes: 0 });
    expect(logged(dir).filter((event) => event.type === 'recall').map((event) => event.data.arm)).toEqual(['shown', 'held']);
  });

  it('post-tool, stop, and a pre-tool miss carry the frame the transcript states, and a private model goes as other', async () => {
    const dir = spoolFolder();
    const { runtime, storeDir } = await deposited();
    const transcript = join(storeDir, 'frame-transcript.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ version: '2.1.300', message: { model: 'claude-opus-4-5' } })}\n`);
    await runHook('post-tool', JSON.stringify({ session_id: 'p', tool_name: 'Bash', tool_response: 'ok', transcript_path: transcript }), runtime, () => NOW, undefined, emitterAt(dir));
    await runHook('stop', JSON.stringify({ transcript_path: transcript }), runtime, () => NOW, undefined, emitterAt(dir));
    await runHook('pre-tool', JSON.stringify({ session_id: 's', tool_name: 'Read', tool_input: { file_path: 'x' }, transcript_path: transcript }), withIndex().runtime, () => NOW, undefined, emitterAt(dir));
    const private_ = join(storeDir, 'private-transcript.jsonl');
    writeFileSync(private_, `${JSON.stringify({ version: '9.9.9-internal', message: { model: 'acme-internal-finetune-7' } })}\n`);
    await runHook('post-tool', JSON.stringify({ session_id: 'p', tool_name: 'Bash', tool_response: 'ok', transcript_path: private_ }), runtime, () => NOW, undefined, emitterAt(dir));
    const [post, stopped, miss, other] = hooks(dir);
    for (const event of [post, stopped, miss]) expect(event?.data).toMatchObject({ harness: 'claude-code', harnessVersion: '2.1.300', model: 'claude-opus-4-5' });
    expect(other?.data.model).toBe('other');
    expect(readSpool(dir).join('')).not.toContain('acme-internal');
    expect(readSpool(dir).join('')).not.toContain('frame-transcript');
  });

  it('a transcript that is missing leaves the fields out and costs the hook nothing', async () => {
    const dir = spoolFolder();
    const { runtime, storeDir } = await deposited();
    await runHook('post-tool', JSON.stringify({ session_id: 'p', tool_name: 'Bash', tool_response: 'ok', transcript_path: join(storeDir, 'missing.jsonl') }), runtime, () => NOW, undefined, emitterAt(dir));
    // A folder where the transcript should be cannot be read: the frame is unknown, the fire still records.
    await runHook('post-tool', JSON.stringify({ session_id: 'p', tool_name: 'Bash', tool_response: 'ok', transcript_path: storeDir }), runtime, () => NOW, undefined, emitterAt(dir));
    expect(hooks(dir)).toHaveLength(2);
    for (const event of hooks(dir)) expect(Object.keys(event.data)).not.toContain('model');
  });

  it('a call no read covers is a miss', async () => {
    const dir = spoolFolder();
    await runHook('pre-tool', JSON.stringify({ session_id: 's', tool_name: 'Read', tool_input: { file_path: 'x' } }), withIndex().runtime, () => NOW, undefined, emitterAt(dir));
    expect(hooks(dir)[0]?.data).toMatchObject({ outcome: 'miss', bytes: 0 });
  });

  it('stop and nightly are fires too, and a hook that fails open records error', async () => {
    const dir = spoolFolder();
    const { runtime, storeDir } = await deposited();
    await runHook('stop', JSON.stringify({}), runtime, () => NOW, undefined, emitterAt(dir));
    await runHook('nightly', '', runtime, () => NOW, undefined, emitterAt(dir));
    // A state file that is a folder cannot be read: the nightly run throws, the hook survives, and the fire says error.
    rmSync(join(storeDir, 'state.json'), { force: true });
    mkdirSync(join(storeDir, 'state.json'), { recursive: true });
    await runHook('nightly', '', runtime, () => NOW, undefined, emitterAt(dir));
    expect(hooks(dir).map((event) => `${String(event.data.name)}:${String(event.data.outcome)}`)).toEqual(['stop:miss', 'nightly:hit', 'nightly:error']);
  });

  it('records nothing when telemetry is off, and a spool that cannot be written costs nothing', async () => {
    const off = spoolFolder();
    const { runtime } = await deposited();
    const args = JSON.stringify({ session_id: 'live', cwd: REPO });
    const baseline = await runHook('session-start', args, runtime, () => NOW);
    expect(await runHook('session-start', args, runtime, () => NOW, undefined, emitterAt(off, { OARS_TELEMETRY: '0' }))).toBe(baseline);
    expect(readSpool(off)).toEqual([]);
    const broken = spoolFolder();
    mkdirSync(join(broken, '..'), { recursive: true });
    writeFileSync(broken, 'a file where the folder should be');
    expect(await runHook('session-start', args, runtime, () => NOW, undefined, emitterAt(broken))).toBe(baseline);
  });

  it('prints the same bytes with telemetry on as without, and with a spool that cannot be written', async () => {
    const on = spoolFolder();
    const broken = spoolFolder();
    mkdirSync(join(broken, '..'), { recursive: true });
    writeFileSync(broken, 'a file where the folder should be');
    const sid = sessionOn('shown');
    const outputs = await Promise.all(
      [undefined, emitterAt(on), emitterAt(broken)].map((emit) => runHook('pre-tool', monitor(sid), withIndex().runtime, () => NOW, undefined, emit)),
    );
    expect(outputs[0]).toBeDefined();
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
    expect(hooks(on)).toHaveLength(1);
  });
});

describe('oars gate hook records one event per fire, after the answer', () => {
  const call = (command: string): string => JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse' });

  /** A store holding a cached not-found answer for `ghost-lib` and a policy that treats it as `action`, with `holdback` percent of notes held. */
  const seeded = (action: 'block' | 'warn', holdback = 0): string => {
    const store = mkdtempSync(join(tmpdir(), 'oars-gate-telemetry-'));
    roots.push(store);
    writeFileSync(join(store, 'gate-policy.json'), JSON.stringify({ classes: { 'not-found': action }, holdbackPercent: holdback }));
    const now = new Date();
    const answer = { kind: 'registry', v: 1, day: now.toISOString().slice(0, 10), ts: now.toISOString(), folder: folderKey(tmpdir()), class: 'npm-package', state: 'not-found', created: null, name: 'ghost-lib', latest: null };
    writeFileSync(join(store, 'gate-registry.jsonl'), `${JSON.stringify(answer)}\n`);
    return store;
  };

  /** One run of the process, with or without a recording; what it printed and how it exited. */
  const fire = async (stdin: string, store: string, emit?: Emit, extra: Partial<GateHookDeps> = {}, framed = false): Promise<{ printed: string; exits: number[] }> => {
    const printed: string[] = [];
    const exits: number[] = [];
    await runHookProcess({
      stdin: () => Promise.resolve(stdin),
      deps: (staging) => ({ storeDir: store, now: () => Date.now(), clock: () => 0, deadlineMs: 800, stage: staging, random: () => 0, ...extra }),
      exit: (code) => { exits.push(code); },
      write: (text) => { printed.push(text); return Promise.resolve(); },
      deadlineMs: 5_000,
      ...(emit === undefined ? {} : { record: framed ? fireRecorder(emit) : (one) => { emit('hook', { name: 'gate', ...one }); } }),
    });
    return { printed: printed.join(''), exits };
  };

  it('a call that crosses nothing is a miss with no bytes', async () => {
    const dir = spoolFolder();
    await fire(call('ls'), seeded('block'), emitterAt(dir));
    expect(hooks(dir)).toHaveLength(1);
    expect(hooks(dir)[0]?.data).toMatchObject({ name: 'gate', outcome: 'miss', bytes: 0 });
  });

  it('a deny is a hit with the bytes printed, and stdout and the exit code are those of a run without telemetry', async () => {
    const dir = spoolFolder();
    const without = await fire(call('npm install ghost-lib'), seeded('block'));
    const withIt = await fire(call('npm install ghost-lib'), seeded('block'), emitterAt(dir));
    expect(without.printed).toContain('"permissionDecision":"deny"');
    expect(withIt).toEqual(without);
    expect(hooks(dir)).toHaveLength(1);
    expect(hooks(dir)[0]?.data).toMatchObject({ name: 'gate', outcome: 'hit', bytes: Buffer.byteLength(without.printed) });
  });

  it('a note is a hit, and a note held back by the arm is held with nothing printed', async () => {
    const dir = spoolFolder();
    const shown = await fire(call('npm install ghost-lib'), seeded('warn', 0), emitterAt(dir));
    const held = await fire(call('npm install ghost-lib'), seeded('warn', 100), emitterAt(dir));
    expect(shown.printed).toContain('additionalContext');
    expect(held.printed).toBe('');
    expect(hooks(dir).map((event) => event.data.outcome)).toEqual(['hit', 'held']);
    expect(hooks(dir)[1]?.data.bytes).toBe(0);
  });

  it('a hook that fails open records error, prints nothing, and exits 0', async () => {
    const dir = spoolFolder();
    const failed = await fire(call('npm install ghost-lib'), seeded('block'), emitterAt(dir), { append: () => Promise.reject(new Error('disk full')) });
    expect(failed).toEqual({ printed: '', exits: [0] });
    expect(hooks(dir)[0]?.data).toMatchObject({ name: 'gate', outcome: 'error', bytes: 0 });
  });

  it('records the harness version and model the transcript states, on a miss and a hit alike, and never its path', async () => {
    const dir = spoolFolder();
    const store = seeded('block');
    const transcript = join(store, 'bare-transcript.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ version: '2.1.300', message: { model: 'claude-opus-4-5' } })}\n`);
    const withPath = (command: string): string => JSON.stringify({ ...JSON.parse(call(command)), transcript_path: transcript });
    await fire(withPath('ls'), store, emitterAt(dir), {}, true);
    await fire(withPath('npm install ghost-lib'), store, emitterAt(dir), {}, true);
    expect(hooks(dir).map((event) => event.data.outcome)).toEqual(['miss', 'hit']);
    for (const event of hooks(dir)) expect(event.data).toMatchObject({ harness: 'claude-code', harnessVersion: '2.1.300', model: 'claude-opus-4-5' });
    expect(readSpool(dir).join('')).not.toContain('bare-transcript');
  });

  it('a hook ended by the deadline records one error event with no bytes, and exits 0 once', async () => {
    const dir = spoolFolder();
    const emit = emitterAt(dir);
    const exits: number[] = [];
    // What the spool held at the moment `exit` was called: the process ends there, so a fire written later is lost.
    const heldAtExit: number[] = [];
    // stdin never resolves, so only the deadline timer can end this fire; the run promise never settles and is not awaited.
    const ended = new Promise<void>((done) => {
      void runHookProcess({
        stdin: () => new Promise<string>(() => undefined),
        deps: (staging) => ({ storeDir: seeded('block'), now: () => Date.now(), clock: () => 0, deadlineMs: 800, stage: staging }),
        exit: (code) => { exits.push(code); heldAtExit.push(hooks(dir).length); done(); },
        write: () => Promise.resolve(),
        deadlineMs: 10,
        // The recorder `hook-main.ts` ships, so an `await` added before its `emit` loses the event at `exit` and fails here.
        record: fireRecorder(emit),
      });
    });
    await ended;
    expect(exits).toEqual([0]);
    expect(heldAtExit).toEqual([1]);
    expect(hooks(dir)).toHaveLength(1);
    expect(hooks(dir)[0]?.data).toMatchObject({ name: 'gate', outcome: 'error', bytes: 0 });
    expect(hooks(dir)[0]?.data).not.toHaveProperty('harnessVersion');
    expect(hooks(dir)[0]?.data).toMatchObject({ harness: 'claude-code' });
  });

  it('a transcript read that never resolves still spools the fire when the deadline arrives', async () => {
    const dir = spoolFolder();
    const emit = emitterAt(dir);
    const exits: number[] = [];
    const heldAtExit: number[] = [];
    const sent = fireRecorder(emit);
    const input = JSON.stringify({ ...JSON.parse(call('ls')), transcript_path: join(tmpdir(), 'oars-stalled-transcript.jsonl') });
    const ended = new Promise<void>((done) => {
      void runHookProcess({
        stdin: () => Promise.resolve(input),
        deps: (staging) => ({ storeDir: seeded('block'), now: () => Date.now(), clock: () => 0, deadlineMs: 800, stage: staging }),
        exit: (code) => { exits.push(code); heldAtExit.push(hooks(dir).length); done(); },
        write: () => Promise.resolve(),
        deadlineMs: 2_000,
        // A transcript on a stalled or locked disk: the read with a path never settles, and the deadline's own call carries none.
        record: (one, transcript) => (transcript === undefined ? sent(one, undefined) : new Promise<void>(() => undefined)),
      });
    });
    await ended;
    expect(exits).toEqual([0]);
    expect(heldAtExit).toEqual([1]);
    expect(hooks(dir)[0]?.data).toMatchObject({ name: 'gate', outcome: 'miss', bytes: 0 });
  });

  it('a throw in the recording changes neither the output nor the exit code', async () => {
    const store = seeded('block');
    const printed: string[] = [];
    const exits: number[] = [];
    await runHookProcess({
      stdin: () => Promise.resolve(call('npm install ghost-lib')),
      deps: (staging) => ({ storeDir: store, now: () => Date.now(), clock: () => 0, deadlineMs: 800, stage: staging }),
      exit: (code) => { exits.push(code); },
      write: (text) => { printed.push(text); return Promise.resolve(); },
      deadlineMs: 5_000,
      record: () => { throw new Error('the spool is on fire'); },
    });
    expect(exits).toEqual([0]);
    expect(printed.join('')).toContain('"permissionDecision":"deny"');
  });
});
