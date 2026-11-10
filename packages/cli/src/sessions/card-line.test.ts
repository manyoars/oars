// The weekly card line, on the card fixture, with the local clock pinned to UTC. Every folder is a temp folder; nothing reads a real store.
process.env.TZ = 'UTC';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type RunDeps } from '../cli.js';
import { harness } from '../test-support.js';
import { readSpool } from '../telemetry/spool.js';
import type { CardLineArm } from '../telemetry/schema.js';
import { cardStore, cardSurvival } from './card-fixture.js';
import type * as StoreModule from './store.js';

const loads = vi.hoisted(() => ({ fail: false, count: 0, empty: false, shift: 0 }));
vi.mock('./store.js', async (original) => ({
  ...(await original<typeof StoreModule>()),
  loadStore: () => {
    loads.count += 1;
    if (loads.fail) return Promise.reject(new Error('unreadable store'));
    const store = cardStore();
    // The fixture's week ends 2026-11-06; `shift` moves its prompts so a later `now` still has a week of sessions.
    const prompts = store.prompts.map((prompt) => (prompt.ts === null ? prompt : { ...prompt, ts: new Date(Date.parse(prompt.ts) + loads.shift).toISOString() }));
    return Promise.resolve(loads.empty ? { ...store, sessions: [], prompts: [], tools: [], errors: [] } : { ...store, prompts });
  },
}));
vi.mock('./survival.js', () => ({ readSurvival: () => Promise.resolve(cardSurvival()) }));

const { CARD_LINE_ARMS, cardLine, cardLineText, fridayOrLater, isHeld, isoWeekOf } = await import('./card-line.js').then(async (m) => ({ ...m, CARD_LINE_ARMS: (await import('../telemetry/schema.js')).CARD_LINE_ARMS }));

/** Friday 2026-11-06: the fixture's three sessions are all inside the week before it. */
const FRIDAY = Date.parse('2026-11-06T12:00:00Z');
const SATURDAY = Date.parse('2026-11-07T12:00:00Z');
const SUNDAY = Date.parse('2026-11-08T12:00:00Z');
const THURSDAY = Date.parse('2026-11-05T23:59:59Z');
const NEXT_FRIDAY = Date.parse('2026-11-13T12:00:00Z');
const LINE = 'Your week: 3 sessions, 13 strokes. `oars card --text` for the table.\n';
const SHOWN_ID = '00000000-0000-4000-8000-000000000001';

let dir: string;
let telemetry: string;
let said: string[];

/** An install id whose holdback hash lands on each side, found by search so the test does not depend on a magic constant. */
const idFor = (held: boolean): string => {
  for (let n = 0; n < 1000; n += 1) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    if (isHeld(id) === held) return id;
  }
  throw new Error('no id found');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-card-line-'));
  telemetry = join(dir, 'telemetry');
  mkdirSync(telemetry);
  writeFileSync(join(telemetry, 'install-id'), `${idFor(false)}\n`);
  said = [];
  loads.fail = false;
  loads.count = 0;
  loads.empty = false;
  loads.shift = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ask = (over: Partial<Parameters<typeof cardLine>[0]> = {}): Promise<CardLineArm> => {
  loads.shift = (over.now ?? FRIDAY) - FRIDAY;
  return cardLine({ storeDir: join(dir, 'store'), telemetryDir: telemetry, now: FRIDAY, tty: true, argv: ['sessions', 'books'], path: ['sessions', 'books'], flags: [], stderr: (text) => said.push(text), ...over });
};

describe('when the line shows', () => {
  it('prints the exact text on the card fixture, once, on a Friday', async () => {
    expect(await ask()).toBe('shown');
    expect(said).toEqual([LINE]);
    expect(LINE).toBe(cardLineText(3, 13));
    expect(JSON.parse(readFileSync(join(dir, 'store', 'card-line.json'), 'utf8'))).toEqual({ week: '2026-W45', arm: 'shown' });
  });

  it('shows the singular forms at one', () => {
    expect(cardLineText(1, 1)).toBe('Your week: 1 session, 1 stroke. `oars card --text` for the table.\n');
    expect(cardLineText(0, 2)).toBe('Your week: 0 sessions, 2 strokes. `oars card --text` for the table.\n');
    expect(LINE).not.toMatch(/install|star|http|\.com/i);
  });

  it('shows once per ISO week, on Saturday or Sunday too, and again the next week', async () => {
    expect(await ask()).toBe('shown');
    for (const now of [FRIDAY, SATURDAY, SUNDAY]) expect(await ask({ now })).toBe('not_due');
    expect(said).toHaveLength(1);
    expect(loads.count).toBe(1);
    expect(await ask({ now: NEXT_FRIDAY })).toBe('shown');
    expect(said).toHaveLength(2);
  });

  it('shows on a Saturday as the first command of the week, and not before Friday 00:00 local', async () => {
    expect(await ask({ now: THURSDAY })).toBe('not_due');
    expect(await ask({ now: Date.parse('2026-11-06T00:00:00Z') })).toBe('shown');
    expect(fridayOrLater(THURSDAY)).toBe(false);
    expect(fridayOrLater(SUNDAY)).toBe(true);
    expect(isoWeekOf(Date.parse('2026-12-31T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekOf(Date.parse('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekOf(Date.parse('2027-01-04T12:00:00Z'))).toBe('2027-W01');
  });

  it.each([
    ['stderr is not a terminal', { tty: false }],
    ['--json is given', { flags: ['json'], argv: ['sessions', 'books', '--json'] }],
    ['--json is only in the arguments', { argv: ['sessions', 'books', '--json'] }],
    ['the MCP server runs', { flags: ['mcp'], path: ['sessions', 'recall'], argv: ['sessions', 'recall', '--mcp'] }],
    ['a hook fires', { path: ['sessions', 'hook', 'install'], argv: ['sessions', 'hook', 'install'] }],
    ['the gate hook fires', { path: [], argv: ['gate', 'hook'] }],
    ['the gate hook is observed', { path: ['gate', 'hook'], argv: ['gate', 'hook'] }],
    ['oars card itself runs', { path: ['card'], argv: ['card', '--text'] }],
    ['no command ran', { path: [], argv: ['--help'] }],
  ] satisfies [string, Partial<Parameters<typeof cardLine>[0]>][])('never when %s', async (_name, over) => {
    expect(await ask(over)).toBe('not_due');
    expect(said).toEqual([]);
    expect(loads.count).toBe(0);
    expect(existsSync(join(dir, 'store', 'card-line.json'))).toBe(false);
  });

  it('never when the week has no session, and still can later in the week', async () => {
    loads.empty = true;
    expect(await ask()).toBe('not_due');
    expect(said).toEqual([]);
    expect(existsSync(join(dir, 'store', 'card-line.json'))).toBe(false);
    loads.empty = false;
    expect(await ask({ now: SATURDAY })).toBe('shown');
  });
});

describe('the holdback', () => {
  it('holds a tenth by a stable hash of the install id, and never prints for them', async () => {
    writeFileSync(join(telemetry, 'install-id'), `${idFor(true)}\n`);
    expect(await ask()).toBe('held');
    expect(said).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'store', 'card-line.json'), 'utf8'))).toEqual({ week: '2026-W45', arm: 'held' });
    expect(await ask({ now: SATURDAY })).toBe('not_due');
    expect(said).toEqual([]);
  });

  it('is about ten percent and the same id lands the same way every time', () => {
    const ids = Array.from({ length: 2000 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    const held = ids.filter(isHeld).length;
    expect(held).toBeGreaterThan(140);
    expect(held).toBeLessThan(260);
    expect(isHeld(SHOWN_ID)).toBe(isHeld(SHOWN_ID));
  });

  it('writes a random id once into the store folder when there is no telemetry id, and keeps it', async () => {
    rmSync(join(telemetry, 'install-id'));
    await ask();
    const own = readFileSync(join(dir, 'store', 'card-line-id'), 'utf8');
    expect(own).toMatch(/^[0-9a-f-]{36}\n$/);
    await ask({ now: NEXT_FRIDAY });
    expect(readFileSync(join(dir, 'store', 'card-line-id'), 'utf8')).toBe(own);
    expect(existsSync(join(telemetry, 'install-id'))).toBe(false);
  });

  it('ignores a telemetry id that is not an id, and a missing telemetry folder', async () => {
    writeFileSync(join(telemetry, 'install-id'), 'not an id');
    expect(['shown', 'held']).toContain(await ask());
    expect(existsSync(join(dir, 'store', 'card-line-id'))).toBe(true);
    expect(['shown', 'held']).toContain(await ask({ telemetryDir: undefined, now: NEXT_FRIDAY }));
  });
});

describe('cost and failure', () => {
  it('swallows a store that cannot be read and a store folder that cannot be written', async () => {
    loads.fail = true;
    expect(await ask()).toBe('not_due');
    loads.fail = false;
    writeFileSync(join(dir, 'blocked'), 'a file where the folder should be');
    expect(await ask({ storeDir: join(dir, 'blocked', 'store') })).toBe('not_due');
    expect(said).toEqual([]);
  });

  it('reads a marker that is not JSON as unmarked', async () => {
    mkdirSync(join(dir, 'store'));
    writeFileSync(join(dir, 'store', 'card-line.json'), 'not json');
    expect(await ask()).toBe('shown');
    writeFileSync(join(dir, 'store', 'card-line.json'), '{"week":5}');
    expect(await ask({ now: NEXT_FRIDAY })).toBe('shown');
  });

  it('takes well under the time a command would notice on the fixture', async () => {
    const started = performance.now();
    await ask();
    const ms = performance.now() - started;
    console.log(`card line due-week path on the card fixture: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

let madeCount = 0;
describe('through run()', () => {
  const made = (tty: boolean): { deps: RunDeps; err: string[]; telemetryDir: string } => {
    const { deps, err } = harness({ APPDATA: dir });
    const telemetryDir = join(dir, `oars-telemetry-${String(madeCount++)}`);
    mkdirSync(telemetryDir);
    writeFileSync(join(telemetryDir, 'install-id'), `${idFor(false)}\n`);
    deps.telemetry = { dir: telemetryDir, platform: 'linux' };
    deps.now = () => FRIDAY;
    deps.sessions = { storeDir: join(dir, 'store'), projectsRoot: join(dir, 'projects'), stdin: Readable.from([]), stdout: { write: () => true }, stderr: { isTTY: tty } };
    return { deps, err, telemetryDir };
  };
  const arms = (telemetryDir: string): unknown[] =>
    readSpool(telemetryDir)
      .map((line): unknown => JSON.parse(line))
      .filter((event) => Reflect.get(Object(event), 'type') === 'command')
      .map((event): unknown => Reflect.get(Object(Reflect.get(Object(event), 'data')), 'cardLine'));

  it('prints the line on stderr after the command, and the command event carries the arm', async () => {
    const { deps, err, telemetryDir } = made(true);
    expect(await run(['telemetry', 'status'], deps)).toBe(0);
    expect(err.join('')).toContain(LINE);
    expect(arms(telemetryDir)).toEqual(['shown']);
    expect(await run(['telemetry', 'status'], deps)).toBe(0);
    expect(arms(telemetryDir)).toEqual(['shown', 'not_due']);
  });

  it('records not_due off a terminal, and nothing when telemetry is off', async () => {
    const quietRun = made(false);
    await run(['telemetry', 'status'], quietRun.deps);
    expect(quietRun.err.join('')).not.toContain('Your week');
    expect(arms(quietRun.telemetryDir)).toEqual(['not_due']);
    const off = made(true);
    off.deps.env.OARS_TELEMETRY = '0';
    await run(['telemetry', 'status'], off.deps);
    expect(readSpool(off.telemetryDir)).toEqual([]);
  });

  it('runs a command with no session runtime and leaves the exit code alone', async () => {
    const { deps } = harness({ APPDATA: dir });
    expect(await run(['--version'], deps)).toBe(0);
  });

  it('never writes on a --json run', async () => {
    const { deps, err } = made(true);
    await run(['telemetry', 'status', '--json'], deps);
    expect(err.join('')).not.toContain('Your week');
  });

  it('lists the closed arms', () => {
    expect(CARD_LINE_ARMS).toEqual(['shown', 'held', 'not_due']);
  });
});
