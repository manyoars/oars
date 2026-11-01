import { copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSession } from './derive.js';
import { books, formatBooks, formatMeasure, measure } from './query.js';
import { makeRedactor } from './redact.js';
import { deposit, depositSession, loadStore, paths } from './store.js';
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

describe('subagent transcripts (A24)', () => {
  const withSubagents = () => {
    const staged = stage();
    const parent = join(staged.projectsRoot, 'proj', 'errors-a', 'subagents');
    mkdirSync(join(parent, 'workflows', 'wf_1'), { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(parent, 'agent-x.jsonl'));
    writeFileSync(join(parent, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), join(parent, 'workflows', 'wf_1', 'agent-y.jsonl'));
    writeFileSync(join(parent, 'agent-x.notes.txt'), 'not a transcript');
    writeFileSync(join(parent, 'workflows', 'wf_1', 'agent-z.meta.json'), '{ torn');
    mkdirSync(join(parent, 'workflows', 'other'));
    return { staged, parent };
  };

  it('deposits subagent transcripts apart from sessions, with their parent and type, and books their tokens to the spawning prompt', async () => {
    const { staged } = withSubagents();
    const first = await deposit(staged.runtime, options);
    expect(first).toMatchObject({ sessions: 4, subagents: 2 });
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 0, subagents: 0, unchanged: 6 });
    const store = await loadStore(staged.storeDir);
    expect(store.sessions).toHaveLength(4);
    expect(store.subagents.map((agent) => [agent.session, agent.parent, agent.agentType, agent.spawnedBy])).toEqual([
      ['errors-a~agent-x', 'errors-a', 'Explore', 't1'],
      ['errors-a~wf_1~agent-y', 'errors-a', null, null],
    ]);
    const agentTools = store.tools.filter((tool) => tool.session === 'errors-a~agent-x');
    expect(agentTools.length).toBeGreaterThan(0);
    expect(agentTools.every((tool) => tool.parent === 'errors-a' && tool.agentType === 'Explore' && !tool.side)).toBe(true);
    const spent = store.subagents[0]?.usage;
    const rows = books(store, 'class', NOW);
    expect(rows.reduce((total, row) => total + row.delegated, 0)).toBe((spent?.input ?? 0) + (spent?.cacheWrite ?? 0) + (spent?.cacheRead ?? 0) + (spent?.output ?? 0));
    expect(rows.reduce((total, row) => total + row.delegated, 0)).toBeGreaterThan(0);
    expect(formatBooks(rows, 'class')).toContain('delegated');
    // Every deposited transcript, main and subagent, is in oars' own raw archive (retention point 4c).
    const raw = join(paths(staged.storeDir).raw, 'proj');
    expect(readFileSync(join(raw, 'errors-a', 'subagents', 'workflows', 'wf_1', 'agent-y.jsonl'), 'utf8')).toBe(readFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), 'utf8'));
    expect(readFileSync(join(raw, 'errors-a.jsonl'), 'utf8')).toBe(readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'));
  });

  it('takes the subagents of a session at its Stop deposit', async () => {
    const { staged, parent } = withSubagents();
    const transcript = join(staged.projectsRoot, 'proj', 'errors-a.jsonl');
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('not-allowed');
    await deposit(staged.runtime, { ...options, allow: ['proj'] });
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('unchanged');
    utimesSync(join(parent, 'agent-x.jsonl'), new Date(NOW), new Date(NOW + 1000));
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('deposited');
    expect((await loadStore(staged.storeDir)).subagents).toHaveLength(2);
  });
});
