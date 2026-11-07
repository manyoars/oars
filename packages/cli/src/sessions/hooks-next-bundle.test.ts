// t926 fix round 1, Item 8: the next-node hooks through a kept signed bundle. The session states its version in the tail of its transcript, the hook reads the replica kept for that
// harness and version, and the bundle's cells answer before the local pool's. A replica that does not verify leaves the local read, and the agent sees no error.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { indexPath, readIndex } from './hook-index.js';
import { runHook } from './hooks.js';
import { contextOf, readOf } from './next-fixtures.js';
import { bundleOf, keep, pair } from './pool-books-fixture.js';
import { armOf, readRecalls } from './recall-object.js';
import type { Position, RecoveryEdge } from './recall-next.js';
import type { Read } from './read.js';
import { deposit } from './store.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const VERSION = '2.1.314';
/** The index key for that version: the bucket is its patch by tens. */
const FRAME = 'claude-code/2.1.31x';
const KEY = 'shell.exec/1';

const recoveryRead = (next: string, followed: number): Read =>
  readOf({ readId: `read:bundle-${next}`, family: 'recovery', slice: { action: 'shell.exec', errorCode: '1', next, week: '2026-11-02' }, value: { followed, of: 10, share: followed / 10 }, n: followed, asOf: { pool: 'p1', day: '2026-11-02' } });

const positionRead = (prefix: string, next: { [action: string]: number }, n: number): Read =>
  readOf({ readId: `read:bundle-${prefix}`, family: 'next-step', slice: { prefix, length: '1' }, value: { next, top: 'shell.exec', topShare: 0.6 }, n, asOf: { pool: 'p1', day: '2026-11-02' } });

const localEdge = (next: string, followed: number): RecoveryEdge => ({ next, followed, of: 20, clusters: 1, readId: 'read:local', day: '2026-11-01' });
const localPosition = (prefix: string, n: number): Position => ({ prefix, n, next: [['file.read', Math.round(n * 0.6)], ['file.edit', Math.round(n * 0.4)]], clusters: 1, readId: 'read:local', day: '2026-11-01' });

interface Setup {
  made: Staged;
  transcript: string;
  replica: string;
}

/** A deposited store with a kept bundle for the session's version, a transcript that states it, and a local index holding `local` under that version's frame key. */
const setup = async (bundleReads: Read[], local: { recovery: RecoveryEdge[]; positions: Position[] }): Promise<Setup> => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(made.storeDir);
  writeFileSync(
    indexPath(made.storeDir),
    JSON.stringify({ ...index, recoveryByFrame: { [FRAME]: { [KEY]: local.recovery } }, positionsByFrame: { [FRAME]: local.positions } }),
  );
  const replica = await keep(made.storeDir, { ...bundleOf(undefined, VERSION), reads: bundleReads }, await pair());
  const transcript = join(made.root, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', version: VERSION, message: { model: 'claude-x' } })}\n`);
  return { made, transcript, replica };
};

/** A session id whose arm is the one asked for, against the bundle's pool version (`p1`), which a bundle read is answered from. */
const sessionOn = (arm: 'shown' | 'held', key: string): string => {
  for (let i = 0; i < 1000; i++) if (armOf(`b${String(i)}`, [key], 'p1') === arm) return `b${String(i)}`;
  throw new Error('no session found');
};

const fail = (session: string, transcript: string): string => JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: session, transcript_path: transcript, tool_name: 'Bash', error: 'Exit code 1\nnothing seen before' });
const start = (session: string, transcript: string): string => JSON.stringify({ hook_event_name: 'SessionStart', session_id: session, transcript_path: transcript, cwd: REPO });

describe('PostToolUseFailure through a kept bundle', () => {
  it("serves the bundle's edge ahead of the local one, answered from the bundle's pool", async () => {
    const { made, transcript } = await setup([recoveryRead('file.edit', 8)], { recovery: [localEdge('file.read', 9)], positions: [] });
    const session = sessionOn('shown', KEY);
    const output = contextOf(await runHook('post-tool', fail(session, transcript), made.runtime, () => NOW));
    expect(output).toContain('file.edit x8');
    expect(output).not.toContain('file.read');
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ arm: 'shown', poolVersion: 'p1', query: { family: 'recovery', prefix: [KEY] } });
    expect(rows[0]?.answer.bytes).toBe(Buffer.byteLength(rows[0]?.answer.rendered ?? ''));
    expect(rows[0]?.answer.bytes).toBeGreaterThan(0);
  });

  it('prints only the local edge when the replica is corrupt, and no error', async () => {
    const { made, transcript, replica } = await setup([recoveryRead('file.edit', 8)], { recovery: [localEdge('file.read', 9)], positions: [] });
    writeFileSync(replica, '{"payload": torn');
    const index = await readIndex(made.storeDir);
    const session = (() => {
      for (let i = 0; i < 1000; i++) if (armOf(`c${String(i)}`, [KEY], index?.at ?? '') === 'shown') return `c${String(i)}`;
      throw new Error('no session found');
    })();
    const output = contextOf(await runHook('post-tool', fail(session, transcript), made.runtime, () => NOW));
    expect(output).toContain('file.read x9');
    expect(output).not.toContain('file.edit');
    expect(await readRecalls(made.storeDir)).toHaveLength(1);
  });

  it('holds the bundle edge back for the held arm: nothing printed, one row', async () => {
    const { made, transcript } = await setup([recoveryRead('file.edit', 8)], { recovery: [], positions: [] });
    expect(await runHook('post-tool', fail(sessionOn('held', KEY), transcript), made.runtime, () => NOW)).toBeUndefined();
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ arm: 'held', poolVersion: 'p1' });
  });
});

describe('SessionStart through a kept bundle', () => {
  it("lists the bundle's position for a prefix both hold, and the local ones it lacks", async () => {
    const { made, transcript } = await setup([positionRead('file.read', { 'shell.exec': 30, 'file.edit': 20 }, 50)], { recovery: [], positions: [localPosition('file.read', 24), localPosition('file.search', 20)] });
    const output = contextOf(await runHook('session-start', start(sessionOn('shown', 'positions'), transcript), made.runtime, () => NOW));
    expect(output).toContain('- after file.read: shell.exec 60%, file.edit 40% (n 50)');
    expect(output).not.toContain('(n 24)');
    expect(output).toContain('- after file.search: file.read 60%, file.edit 40% (n 20)');
    expect(output.indexOf('after file.read')).toBeLessThan(output.indexOf('after file.search'));
  });

  it("lists the bundle's positions ahead of a local one with more observations", async () => {
    const { made, transcript } = await setup([positionRead('file.read', { 'shell.exec': 30, 'file.edit': 20 }, 25)], { recovery: [], positions: [localPosition('file.search', 90)] });
    const output = contextOf(await runHook('session-start', start(sessionOn('shown', 'positions'), transcript), made.runtime, () => NOW));
    expect(output).toContain('after file.read');
    expect(output).toContain('after file.search');
    expect(output.indexOf('after file.read')).toBeLessThan(output.indexOf('after file.search'));
  });

  it('prints only the local table when the replica is corrupt', async () => {
    const { made, transcript, replica } = await setup([positionRead('file.read', { 'shell.exec': 30, 'file.edit': 20 }, 50)], { recovery: [], positions: [localPosition('file.search', 20)] });
    writeFileSync(replica, '{"payload": torn');
    const index = await readIndex(made.storeDir);
    const session = (() => {
      for (let i = 0; i < 1000; i++) if (armOf(`d${String(i)}`, ['positions'], index?.at ?? '') === 'shown') return `d${String(i)}`;
      throw new Error('no session found');
    })();
    const output = contextOf(await runHook('session-start', start(session, transcript), made.runtime, () => NOW));
    expect(output).toContain('- after file.search');
    expect(output).not.toContain('after file.read');
  });
});
