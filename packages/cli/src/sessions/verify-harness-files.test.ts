// `oars sessions verify` states the three file counts per harness, in its text and its JSON document.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsVerify } from './command.js';
import { addProject, cleanup, NOW, rolloutLine, stage, stageCodex } from './test-support.js';

afterEach(cleanup);

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const yields = (id: string): unknown[] => [
  rolloutLine(T(0), 'session_meta', { session_id: id, id, timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
  rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
  rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'fix the build' }),
  rolloutLine(T(3), 'event_msg', { type: 'agent_message', message: 'done' }),
];

describe('sessionsVerify, files per harness', () => {
  it('prints seen, yielded, and unreadable for each harness in the text and the JSON document', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    addProject(staged, 'p', 'good', [JSON.stringify({ type: 'user', uuid: 'u', timestamp: T(0), message: { role: 'user', content: 'hi' } })]);
    addProject(staged, 'p', 'moved', [JSON.stringify({ kind: 'prompt', body: 'hi' })]);
    const home = stageCodex(staged.root, [
      { id: A, lines: yields(A) },
      { id: B, lines: [{ shape: 'moved' }] },
    ]);
    const runtime = { ...staged.runtime, sourceRoots: { codex: home } };
    const verified = await sessionsVerify({ sessions: runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.report.harnessFiles).toEqual({ 'claude-code': { seen: 2, yielded: 1, unreadable: 1 }, codex: { seen: 2, yielded: 1, unreadable: 1 } });
    expect(verified.document).toMatchObject({ harnessFiles: verified.report.harnessFiles });
    expect(verified.text).toContain('Claude Code: seen 2, yielded 1, unreadable 1');
    expect(verified.text).toContain('Codex: seen 2, yielded 1, unreadable 1');
    // A count, not a conclusion: the text names no cause and no path.
    expect(verified.text).not.toMatch(/broken|outdated|changed format/i);
    expect(verified.text).not.toContain(home);
  });

  it('prints nothing when no harness has a file', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.report.harnessFiles).toEqual({});
    expect(verified.text).not.toContain('Session files per harness');
  });

  it('leaves a harness the saved allowlist does not name out of the counts', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const home = stageCodex(staged.root, [{ id: A, lines: yields(A) }]);
    addProject(staged, 'p', 'good', [JSON.stringify({ type: 'user', uuid: 'u', timestamp: T(0), message: { role: 'user', content: 'hi' } })]);
    const { deposit } = await import('./store.js');
    await deposit({ ...staged.runtime, sourceRoots: { codex: home } }, { allow: ['p'], redactDomains: [], now: () => NOW });
    const verified = await sessionsVerify({ sessions: { ...staged.runtime, sourceRoots: { codex: home } }, install: undefined, now: () => NOW }, { session: undefined });
    expect(Object.keys(verified.report.harnessFiles)).toEqual(['claude-code']);
  });
});
