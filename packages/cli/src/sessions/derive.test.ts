import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSession } from './derive.js';
import { formatMeasure, measure } from './query.js';
import { makeRedactor } from './redact.js';
import { deposit, loadStore, paths } from './store.js';
import { cleanup, FIXTURES, NOW, stage } from './test-support.js';

afterEach(cleanup);

const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

describe('the derive stage (register A28)', () => {
  it('re-derives the version-2 records from the log alone: deleting every raw transcript changes nothing a reader sees', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const before = await loadStore(staged.storeDir);
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    const after = await loadStore(staged.storeDir);
    expect(after).toEqual(before);
    expect(formatMeasure(measure(after, [], [], 5))).toBe(formatMeasure(measure(before, [], [], 5)));
    expect(after.prompts.length).toBeGreaterThan(0);
    expect(after.errors.length).toBeGreaterThan(0);
  });

  it('derives from the log what capture plus derive in one pass computes from raw', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const store = await loadStore(staged.storeDir);
    const raw = extractSession({
      text: readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'),
      session: 'errors-a',
      project: 'proj',
      rev: store.sessions.find((session) => session.session === 'errors-a')?.rev ?? 0,
      at: '',
      bytes: 0,
      redact: makeRedactor(),
    });
    const strip = (records: readonly { session: string }[]) => records.filter((record) => record.session === 'errors-a');
    expect(strip(store.prompts)).toEqual(raw.prompts);
    expect(strip(store.errors)).toEqual(raw.errors);
  });

  it('keeps a version-2 session as written, files a subagent transcript apart, and skips records with no session line', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const v2 = extractSession({ text: readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'), session: 'old', project: 'proj', rev: 1, at: '', bytes: 0, redact: makeRedactor() });
    // A version-2 session line: `v` instead of `cv`, and no parent or agent fields.
    const legacy: { [key: string]: unknown } = { ...v2.session, v: '2' };
    for (const key of ['cv', 'parent', 'agentType', 'spawnedBy']) Reflect.deleteProperty(legacy, key);
    const child = extractSession({
      text: readFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), 'utf8'),
      session: 'old~agent-a',
      project: 'proj',
      rev: 1,
      at: '',
      bytes: 0,
      redact: makeRedactor(),
      subagent: { parent: 'old', agentType: 'Explore', spawnedBy: 'toolu_1' },
    });
    const lines = [legacy, ...v2.prompts, ...v2.errors, child.session, ...child.tools, { ...v2.tools[0], session: 'orphan' }];
    writeFileSync(paths(staged.storeDir).observations, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const store = await loadStore(staged.storeDir);
    expect(store.sessions).toEqual([expect.objectContaining({ session: 'old', cv: '2', parent: null, agentType: null, spawnedBy: null })]);
    expect(store.prompts).toEqual(v2.prompts);
    expect(store.errors).toEqual(v2.errors);
    expect(store.subagents).toEqual([expect.objectContaining({ session: 'old~agent-a', parent: 'old', agentType: 'Explore', spawnedBy: 'toolu_1' })]);
    expect(store.tools).toEqual(child.tools);
  });
});
