import { copyFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { readHookCalls } from './hook-calls.js';
import { runHook } from './hooks.js';
import { readSteps } from './steps.js';
import { deposit, loadStore } from './store.js';
import { cleanup, FIXTURES, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = join('work', 'app');

const deposited = async (): Promise<Staged> => {
  const staged = stage(slugOf(REPO));
  await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  return staged;
};

/** A finished session the store has not seen, in the allowed folder. */
const finished = (staged: Staged, name: string): string => {
  const transcript = join(staged.projectsRoot, slugOf(REPO), `${name}.jsonl`);
  copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
  return transcript;
};

const stopInput = (session: string, transcript: string): string => JSON.stringify({ session_id: session, transcript_path: transcript, hook_event_name: 'Stop' });

const sessionIds = async (staged: Staged): Promise<string[]> => (await loadStore(staged.storeDir)).sessions.map((session) => session.session);

describe('a Stop hook deposit that meets a held store lock (t832 item 1: what happens today)', () => {
  it('records a failed deposit row and a hook-call error, exits quietly, and leaves the session to the next whole-store deposit', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'missed');
    const rowsBefore = (await readSteps(staged.storeDir)).length;
    writeFileSync(join(staged.storeDir, 'store.lock'), 'a holder that never frees');

    // The hook never fails its session: runHook resolves with no output, and hook-bin.ts exits 0 whatever happens.
    expect(await runHook('stop', stopInput('missed', transcript), staged.runtime, () => NOW)).toBeUndefined();

    const rows = (await readSteps(staged.storeDir)).slice(rowsBefore);
    expect(rows.map((row) => [row.trigger, row.step, row.status])).toEqual([['stop', 'deposit', 'error']]);
    expect(rows[0]?.error).toContain('The store is locked by another deposit');
    expect(rows[0]?.out).toEqual({});
    const calls = (await readHookCalls(staged.storeDir)).filter((call) => call.session === 'missed');
    expect(calls.map((call) => [call.event, call.hit])).toEqual([['stop', false]]);
    expect(calls[0]?.error).toContain('store is locked');
    // The refusal wrote nothing about the session.
    expect(await sessionIds(staged)).not.toContain('missed');

    // The lock is released and a whole-store deposit runs: it finds the transcript by walking the allowed folder, because state.json never saw it.
    await rm(join(staged.storeDir, 'store.lock'));
    const result = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(result.sessions).toBe(1);
    expect(await sessionIds(staged)).toContain('missed');
  }, 20_000); // the hook waits out its 3 s lock wait
});
