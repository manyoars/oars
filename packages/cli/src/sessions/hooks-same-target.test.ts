// The failure hook serves a bundle's same-target read beside the edge line, and is byte-identical to before when the bundle holds none.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { runHook } from './hooks.js';
import { contextOf, readOf } from './next-fixtures.js';
import { bundleOf, keep, pair } from './pool-books-fixture.js';
import { armOf, readRecalls } from './recall-object.js';
import type { Read } from './read.js';
import { deposit } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const VERSION = '2.1.314';
const KEY = 'file.edit/1';

const edge = (next: string, followed: number): Read => readOf({ readId: `read:edge-${next}`, family: 'recovery', slice: { action: 'file.edit', errorCode: '1', next, week: '2026-11-02' }, value: { followed, of: 10, share: followed / 10 }, n: followed, asOf: { pool: 'p1', day: '2026-11-02' } });
const same = (step: string, target = 'source'): Read =>
  readOf({ readId: 'read:same', family: 'recovery', slice: { failed: 'file.edit', errorCode: '1', target, step, week: '2026-11-02' }, value: { recovered: 6, followed: 8, of: 12, share: 0.5 }, n: 6, asOf: { pool: 'p1', day: '2026-11-02' } });

const setup = async (reads: Read[]) => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  await keep(made.storeDir, { ...bundleOf(undefined, VERSION), reads }, await pair());
  const transcript = join(made.root, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', version: VERSION, message: { model: 'claude-x' } })}\n`);
  return { made, transcript };
};

const session = (): string => {
  for (let i = 0; i < 1000; i++) if (armOf(`s${String(i)}`, [KEY], 'p1') === 'shown') return `s${String(i)}`;
  throw new Error('no session found');
};

const fail = (sid: string, transcript: string, toolInput: object): string =>
  JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: sid, transcript_path: transcript, tool_name: 'Edit', tool_input: toolInput, cwd: '/work/app', error: 'Exit code 1\nnothing seen before' });

const EDGE_LINE = 'oars recall, counts from earlier sessions: after a failed file.edit (1) in 8 failures, the next step was\n  file.read x8 (100%)\n  read read:edge-file.read (recovery)';

describe('PostToolUseFailure same-target read', () => {
  it('adds the same-target line after the edge line', async () => {
    const { made, transcript } = await setup([edge('file.read', 8), same('file.search')]);
    const output = contextOf(await runHook('post-tool', fail(session(), transcript, { file_path: 'src/a.ts' }), made.runtime, () => NOW));
    expect(output).toBe(`${EDGE_LINE}\noars recall, counts from earlier sessions: after a failed file.edit (1) on a source target, file.search came back ok 6 of 8 times it followed\n  read read:same (recovery)`);
    const rows = await readRecalls(made.storeDir);
    expect(rows[0]?.answer.reads).toEqual(['read:edge-file.read', 'read:same']);
  });

  it('serves the same-target line alone when the bundle holds no edge, and words a same-action step as another kind of target', async () => {
    const { made, transcript } = await setup([same('file.edit')]);
    const output = contextOf(await runHook('post-tool', fail(session(), transcript, { file_path: 'src/a.ts' }), made.runtime, () => NOW));
    expect(output).toBe('oars recall, counts from earlier sessions: after a failed file.edit (1) on a source target, the same action on another kind of target came back ok 6 of 8 times it followed\n  read read:same (recovery)');
  });

  it('serves the same-target line alone when the edge top is a retry, which silences only the edge line', async () => {
    const { made, transcript } = await setup([edge('file.edit', 8), same('file.search')]);
    const output = contextOf(await runHook('post-tool', fail(session(), transcript, { file_path: 'src/a.ts' }), made.runtime, () => NOW));
    expect(output).toBe('oars recall, counts from earlier sessions: after a failed file.edit (1) on a source target, file.search came back ok 6 of 8 times it followed\n  read read:same (recovery)');
  });

  it('is byte-identical to the edge line when the bundle holds no read for this target class', async () => {
    const { made, transcript } = await setup([edge('file.read', 8), same('file.search', 'test')]);
    const output = contextOf(await runHook('post-tool', fail(session(), transcript, { file_path: 'src/a.ts' }), made.runtime, () => NOW));
    expect(output).toBe(EDGE_LINE);
  });

  it('serves no same-target read for a call with no path, and the output is the edge line as before', async () => {
    const { made, transcript } = await setup([edge('file.read', 8), same('file.search')]);
    const output = contextOf(await runHook('post-tool', fail(session(), transcript, {}), made.runtime, () => NOW));
    expect(output).toBe(EDGE_LINE);
  });
});
