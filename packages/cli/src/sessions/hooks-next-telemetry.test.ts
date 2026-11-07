// Item 4 of t926: each new hook fire (the recovery edge, the table at session start, the table at a prompt) is counted through the hook telemetry as a hit, a miss, or a held read, with the
// bytes it injected, and a shown or held read is one `recall` event beside it. The events pass the closed schema, so a name or field it does not know would be dropped here.
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { indexPath, readIndex } from './hook-index.js';
import { runHook } from './hooks.js';
import { armOf } from './recall-object.js';
import type { Position, RecoveryEdge } from './recall-next.js';
import { sanitize } from '../telemetry/schema.js';
import { deposit } from './store.js';
import { indexAtOf } from './next-fixtures.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const KEY = 'shell.exec/1';
const edge = (next: string, followed: number): RecoveryEdge => ({ next, followed, of: 20, clusters: 1, readId: 'read:0123456789abcdef', day: '2026-11-01' });
const position: Position = { prefix: 'file.edit', n: 20, next: [['shell.exec', 12], ['file.read', 8]], clusters: 1, readId: 'read:aaaaaaaaaaaaaaaa', day: '2026-11-01' };

const staged = async (recovery: { [key: string]: RecoveryEdge[] }, positions: Position[]): Promise<Staged> => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(made.storeDir);
  writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, recovery, positions }));
  return made;
};

const sessionOn = (made: Staged, arm: 'shown' | 'held', key: string): string => {
  const at = indexAtOf(made.storeDir);
  for (let i = 0; i < 1000; i++) if (armOf(`s${String(i)}`, [key], at) === arm) return `s${String(i)}`;
  throw new Error('no session found');
};

interface Event {
  type: string;
  fields: { [field: string]: unknown };
}
const run = async (made: Staged, event: 'session-start' | 'prompt' | 'post-tool', input: object): Promise<{ output: string | undefined; events: Event[] }> => {
  const events: Event[] = [];
  const output = await runHook(event, JSON.stringify(input), made.runtime, () => NOW, undefined, (type, fields) => events.push({ type, fields: { ...fields } }));
  return { output, events };
};
const hook = (events: Event[]): Event | undefined => events.find((event) => event.type === 'hook');

const failure = (session: string): object => ({ hook_event_name: 'PostToolUseFailure', session_id: session, tool_name: 'Bash', error: 'Exit code 1\nx' });
const startOf = (session: string): object => ({ hook_event_name: 'SessionStart', session_id: session, cwd: REPO });
const promptOf = (session: string): object => ({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: REPO, prompt: 'go' });

describe('the hook telemetry of the next-node reads', () => {
  it('counts a served recovery read as a hit with its bytes, and one recall event on the shown arm', async () => {
    const made = await staged({ [KEY]: [edge('file.read', 12)] }, []);
    const { output, events } = await run(made, 'post-tool', failure(sessionOn(made, 'shown', KEY)));
    expect(hook(events)?.fields).toMatchObject({ name: 'post-tool', outcome: 'hit', bytes: Buffer.byteLength(output ?? '') });
    expect(Number(hook(events)?.fields.bytes)).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'recall')).toHaveLength(1);
    expect(events.find((event) => event.type === 'recall')?.fields).toMatchObject({ arm: 'shown', mode: 'push' });
  });

  it('counts a held recovery read as held with no bytes, and a retry cell as a miss with no recall event', async () => {
    const made = await staged({ [KEY]: [edge('file.read', 12)], 'shell.exec/2': [edge('shell.exec', 9)] }, []);
    const held = await run(made, 'post-tool', failure(sessionOn(made, 'held', KEY)));
    expect(hook(held.events)?.fields).toMatchObject({ outcome: 'held', bytes: 0 });
    expect(held.events.find((event) => event.type === 'recall')?.fields).toMatchObject({ arm: 'held' });
    const silent = await run(made, 'post-tool', { ...failure(sessionOn(made, 'shown', 'shell.exec/2')), error: 'Exit code 2\nx' });
    expect(hook(silent.events)?.fields).toMatchObject({ outcome: 'miss', bytes: 0 });
    expect(silent.events.some((event) => event.type === 'recall')).toBe(false);
  });

  it('counts the table at session start as a hit with its bytes, a held one as a held recall with no table bytes, and an unchanged table at a prompt as a miss', async () => {
    const made = await staged({}, [position]);
    const shown = sessionOn(made, 'shown', 'positions');
    const first = await run(made, 'session-start', startOf(shown));
    expect(hook(first.events)?.fields).toMatchObject({ name: 'session-start', outcome: 'hit' });
    expect(Number(hook(first.events)?.fields.bytes)).toBeGreaterThan(0);
    const again = await run(made, 'prompt', promptOf(shown));
    expect(hook(again.events)?.fields).toMatchObject({ name: 'prompt', outcome: 'miss', bytes: 0 });
    const held = await run(made, 'session-start', startOf(sessionOn(made, 'held', 'positions')));
    // The session start still injects its context block, so the fire is a hit for what went out; the held table is the recall event's arm and adds no bytes.
    expect(held.events.find((event) => event.type === 'recall')?.fields).toMatchObject({ arm: 'held' });
    expect(held.output ?? '').not.toContain('oars recall, next steps');
    expect(Number(hook(held.events)?.fields.bytes)).toBeLessThan(Number(hook(first.events)?.fields.bytes));
  });

  it('counts a changed table at a prompt as a hit with its bytes', async () => {
    const made = await staged({}, [position]);
    const session = sessionOn(made, 'shown', 'positions');
    await run(made, 'session-start', startOf(session));
    const index = await readIndex(made.storeDir);
    writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, positions: [position, { ...position, prefix: 'file.read', n: 30 }] }));
    const changed = await run(made, 'prompt', promptOf(session));
    expect(hook(changed.events)?.fields).toMatchObject({ name: 'prompt', outcome: 'hit' });
    expect(Number(hook(changed.events)?.fields.bytes)).toBe(Buffer.byteLength(changed.output ?? ''));
  });

  it('is accepted by the closed telemetry schema, prompt hook included', async () => {
    const made = await staged({}, [position]);
    const session = sessionOn(made, 'shown', 'positions');
    const { events } = await run(made, 'prompt', promptOf(session));
    const fields = hook(events)?.fields ?? {};
    expect(sanitize('hook', fields)).toBeDefined();
    expect(sanitize('hook', { ...fields, name: 'prompt' })).toBeDefined();
  });
});
